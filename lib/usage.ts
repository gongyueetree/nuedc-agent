import { db, ensureSchema, uid, withTransaction, type TxExecutor } from "./db";
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

  // 计数器自增与预占记录必须同一事务：
  // 两步分离时，第二步失败会造成「计数器已扣但没有 reservation」的配额泄漏 ——
  // 用户额度被占用却永远无法返还，只能等次日 0 点重置。
  return withTransaction(async (tx) => {
    if (quota === -1) {
      await tx.execute({
        sql: "INSERT INTO llm_usage (owner, kind, detail, status, ref) VALUES (?,?,?,?,?)",
        args: [owner, kind, "unlimited", "reserved", ref],
      });
      return { reservation: { ref, used: 0, quota } };
    }

    // 条件自增：仅当当日用量 < quota 才 +1 并返回新值；并发下由数据库保证互斥
    const rs = await tx.execute({
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
    await tx.execute({
      sql: "INSERT INTO llm_usage (owner, kind, detail, status, ref) VALUES (?,?,?,?,?)",
      args: [owner, kind, `${used}/${quota}`, "reserved", ref],
    });
    // 走到这里两步都成功；任一步抛错都会回滚，计数器恢复原值
    return { reservation: { ref, used, quota } };
  });
}

/** 成功：把预占转为正式消耗。
 *  传入 tx 时在调用方的事务内执行 —— 任务状态转换与配额结算必须同生共死，
 *  否则进程在两者之间崩溃会留下不一致状态。 */
export async function commitQuota(ref: string, tx?: TxExecutor): Promise<void> {
  const doCommit = async (exec: TxExecutor) => {
    await exec.execute({
      sql: "UPDATE llm_usage SET status='success' WHERE ref=? AND status='reserved' RETURNING id",
      args: [ref],
    });
    // 未命中说明已结算过，幂等返回；命中与否都不需要动计数器
    // （预占时已 +1，成功即维持该计数）
  };
  if (tx) return doCommit(tx);
  await withTransaction(doCommit);
}

/** 失败：返还配额（计数器 -1，用量标记为 refunded）。
 *  同 commitQuota，传入 tx 时在调用方事务内执行。
 *  两条语句顺序固定：先标记用量状态，命中才回退计数器，
 *  保证「重复调用不会把计数器减多次」。 */
export async function refundQuota(owner: string, kind: string, ref: string, tx?: TxExecutor): Promise<void> {
  /** 核心不变式：只有把 llm_usage 从 reserved 改成 refunded 成功的那一次，
   *  才允许回退计数器。否则重复退款会把计数器减多次，用户凭空多出额度。 */
  const doRefund = async (exec: TxExecutor) => {
    const marked = await exec.execute({
      sql: "UPDATE llm_usage SET status='refunded' WHERE ref=? AND status='reserved' RETURNING id",
      args: [ref],
    });
    if (!marked.rows.length) return;   // 已结算过，幂等返回，不动计数器
    await exec.execute({
      sql: `UPDATE quota_counters SET used = GREATEST(used - 1, 0)
            WHERE owner=? AND kind=? AND day = CURRENT_DATE`,
      args: [owner, kind],
    });
  };

  // 复用调用方事务；没有则自己开一个真事务 ——
  // 此前的事务外路径无条件执行 used-1，重复调用会重复扣减
  if (tx) return doRefund(tx);
  await withTransaction(doRefund);
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
