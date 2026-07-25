import { db, ensureSchema, uid } from "./db";
import type { UserTier } from "./types";

/** 配额与用量。
 *  诊断 P0-2：检查与占用必须原子，否则并发请求能突破限额。
 *  诊断 P0-3：先预占（reserved），失败自动返还，不让系统故障扣用户次数。 */

export const DAILY_QUOTA: Record<string, Record<UserTier, number>> = {
  pdf_extract: { free: 2, paid: 20, lab: -1, admin: -1 },
  // 重型生成任务（方案/代码/报告）：防止单用户刷爆全局预算
  heavy_task: { free: 10, paid: 100, lab: -1, admin: -1 },
  // 附件导入：免费用户不开放
  module_ingest: { free: 0, paid: 10, lab: -1, admin: -1 },
};

export function quotaFor(kind: string, tier: UserTier): number {
  return DAILY_QUOTA[kind]?.[tier] ?? 0;
}

export interface Reservation {
  ref: string;
  used: number;
  quota: number;
}

/** 原子预占一次配额。返回 null 表示超限（附原因在 error）。 */
export async function reserveQuota(
  owner: string, kind: string, tier: UserTier
): Promise<{ reservation?: Reservation; error?: string }> {
  const quota = quotaFor(kind, tier);
  if (quota === 0) return { error: "该能力未对当前账户开放" };
  await ensureSchema();
  const ref = uid("USE");

  if (quota === -1) {
    await db().execute({
      sql: "INSERT INTO llm_usage (owner, kind, detail, status, ref) VALUES (?,?,?,?,?)",
      args: [owner, kind, "unlimited", "reserved", ref],
    });
    return { reservation: { ref, used: 0, quota } };
  }

  // 原子自增：仅当当日用量 < quota 才 +1 并返回新值；并发下由数据库保证互斥
  const rs = await db().execute({
    sql: `INSERT INTO quota_counters (owner, kind, day, used) VALUES (?, ?, CURRENT_DATE, 1)
          ON CONFLICT (owner, kind, day)
          DO UPDATE SET used = quota_counters.used + 1
          WHERE quota_counters.used < ?
          RETURNING used`,
    args: [owner, kind, quota],
  });
  if (!rs.rows.length) {
    return { error: `今日配额已用完（${quota}/${quota}）。付费账户配额更高；每日 0 点重置。` };
  }
  const used = Number(rs.rows[0].used);
  await db().execute({
    sql: "INSERT INTO llm_usage (owner, kind, detail, status, ref) VALUES (?,?,?,?,?)",
    args: [owner, kind, `${used}/${quota}`, "reserved", ref],
  });
  return { reservation: { ref, used, quota } };
}

/** 成功：把预占转为正式消耗 */
export async function commitQuota(ref: string): Promise<void> {
  await db().execute({
    sql: "UPDATE llm_usage SET status='success' WHERE ref=? AND status='reserved'",
    args: [ref],
  }).catch(() => {});
}

/** 失败：返还配额（计数器 -1，用量标记为 refunded） */
export async function refundQuota(owner: string, kind: string, ref: string): Promise<void> {
  await db().execute({
    sql: `UPDATE quota_counters SET used = GREATEST(used - 1, 0)
          WHERE owner=? AND kind=? AND day = CURRENT_DATE`,
    args: [owner, kind],
  }).catch(() => {});
  await db().execute({
    sql: "UPDATE llm_usage SET status='refunded' WHERE ref=? AND status='reserved'",
    args: [ref],
  }).catch(() => {});
}

/** 今日已用（只计 reserved + success，refunded 不计） */
export async function usedToday(owner: string, kind: string): Promise<number> {
  await ensureSchema();
  const rs = await db().execute({
    sql: "SELECT used FROM quota_counters WHERE owner=? AND kind=? AND day=CURRENT_DATE",
    args: [owner, kind],
  });
  return Number(rs.rows[0]?.used || 0);
}

export async function recordUsage(owner: string, kind: string, detail?: string): Promise<void> {
  await db().execute({
    sql: "INSERT INTO llm_usage (owner, kind, detail, status) VALUES (?,?,?, 'success')",
    args: [owner, kind, (detail || "").slice(0, 500)],
  }).catch(() => {});
}
