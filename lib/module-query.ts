import { db, ensureSchema } from "./db";

/* ---------------------------------------------------------------------------
 * 模块数据治理 —— 移植自 eehubio/ai-hardware-genesis-platform 的三套机制，
 * 字段权重适配电赛模块 schema：
 *   1) scoreCompleteness   透明的 0~100 完整度评分（编辑后台"还缺什么"视图）
 *   2) queryCapabilities   结构化能力查询（普通搜索答不了的问题）
 *   3) governanceReport    治理总览（平均完整度 / 低分名单 / 待审核 / 来源分布）
 * ------------------------------------------------------------------------- */

interface Field { key: string; weight: number; present: (m: any) => boolean }

const FIELDS: Field[] = [
  { key: "name", weight: 3, present: (m) => !!m.name },
  { key: "category", weight: 3, present: (m) => !!m.category },
  { key: "main_chip", weight: 3, present: (m) => !!m.main_chip },
  { key: "description", weight: 4, present: (m) => !!m.description && m.description.length > 8 },
  { key: "price", weight: 2, present: (m) => typeof m.price === "number" && m.price > 0 },
  { key: "tags", weight: 3, present: (m) => !!m.tags?.length },
  // 接口（规则引擎的输入，权重最高）
  { key: "interfaces", weight: 8, present: (m) => !!m.interfaces?.length },
  { key: "interfaces.pins", weight: 5, present: (m) => !!m.interfaces?.some((i: any) => i.pins?.length) },
  { key: "interfaces.constraints", weight: 4, present: (m) => !!m.interfaces?.some((i: any) => i.constraints?.length) },
  // 电气（电源预算检查的输入）
  { key: "power.input_voltage_range", weight: 6, present: (m) => !!m.power?.input_voltage_range },
  { key: "power.typical_current_ma", weight: 5, present: (m) => m.power?.typical_current_ma != null },
  { key: "power.peak_current_ma", weight: 4, present: (m) => m.power?.peak_current_ma != null },
  // 工程经验（学生最需要的部分）
  { key: "usage_notes", weight: 5, present: (m) => !!m.usage_notes?.length },
  { key: "known_issues", weight: 4, present: (m) => !!m.known_issues?.length },
  { key: "competition_cases", weight: 4, present: (m) => !!m.competition_cases?.length },
  { key: "compatibility", weight: 2, present: (m) => !!m.compatibility?.length },
  // 来源与资产
  { key: "source_snapshot", weight: 3, present: (m) => !!m.source_snapshot?.source },
  { key: "schematic_assets", weight: 4, present: (m) => !!m.schematic_assets?.length },
  { key: "code_repositories", weight: 4, present: (m) => !!m.code_repositories?.length },
];
const TOTAL = FIELDS.reduce((s, f) => s + f.weight, 0);

export interface CompletenessReport { score: number; missing: string[] }

export function scoreCompleteness(m: any): CompletenessReport {
  let got = 0;
  const missing: string[] = [];
  for (const f of FIELDS) (f.present(m) ? (got += f.weight) : missing.push(f.key));
  return { score: Math.round((got / TOTAL) * 100), missing };
}

/* ------------------------------ 能力查询 ------------------------------ */

export interface CapabilityQuery {
  q?: string;                // 名称/id/芯片/描述 全文
  category?: string;         // 前缀匹配，如 "signal"
  status?: string;           // 认证状态；all=不过滤（默认排除 DRAFT/DEPRECATED）
  interfaceType?: string;    // I2C / SPI / UART …
  vAtLeast?: number;         // 接口电平 ≥
  vAtMost?: number;          // 接口电平 ≤
  fiveVTolerant?: boolean;   // 是否 5V 容忍
  minPeakMa?: number;        // 峰值(或典型)电流 ≥ —— 找"大电流负载"
  maxPeakMa?: number;        // ≤ —— 找低功耗模块
  usesChip?: string;         // 主芯片子串
  minCompleteness?: number;
  limit?: number;
  /** 可见范围（P0 安全修复）：不传则 fail-closed，只返回公共模块。
   *  私有模块绝不能因为调用方忘了传参而泄露给其他组织。 */
  viewerRef?: string | null;
  orgRef?: string | null;
}

/** 可见性 SQL 片段与参数。
 *  空值用不可能匹配的哨兵值而非 IS NULL —— 否则 org_ref 为空的历史脏数据会被任何人看到。 */
export const VISIBILITY_SENTINEL = "__none__";

export function visibilityClause(orgRef?: string | null, viewerRef?: string | null) {
  return {
    sql: `(scope = 'PUBLIC' OR scope IS NULL
           OR (scope = 'ORGANIZATION' AND org_ref = ?)
           OR (scope IN ('PERSONAL','TEAM') AND owner_ref = ?))`,
    args: [orgRef || VISIBILITY_SENTINEL, viewerRef || VISIBILITY_SENTINEL],
  };
}

export async function queryCapabilities(qy: CapabilityQuery) {
  await ensureSchema();
  const vis = visibilityClause(qy.orgRef, qy.viewerRef);
  const rs = await db().execute({
    sql: `SELECT id, data, certification_status, downloads, rating, scope, owner_ref, org_ref
          FROM modules WHERE ${vis.sql} LIMIT 1000`,
    args: vis.args,
  });
  let list = rs.rows.map((r) => ({
    ...JSON.parse(String(r.data)),
    certification_status: String(r.certification_status),
    downloads: Number(r.downloads || 0),
    rating: Number(r.rating || 0),
    // 归属信息以数据库列为准，不采信 data JSON 里的值（客户端可能写过）
    scope: r.scope ? String(r.scope) : "PUBLIC",
    owner_ref: r.owner_ref ? String(r.owner_ref) : null,
    org_ref: r.org_ref ? String(r.org_ref) : null,
  }));

  if (qy.status !== "all") {
    const st = qy.status;
    list = st
      ? list.filter((m) => m.certification_status === st)
      : list.filter((m) => !["DRAFT", "DEPRECATED"].includes(m.certification_status));
  }
  if (qy.category) list = list.filter((m) => String(m.category).startsWith(qy.category!));
  if (qy.q) {
    const s = qy.q.toLowerCase();
    list = list.filter((m) =>
      `${m.id} ${m.name} ${m.main_chip} ${m.description} ${(m.tags || []).join(" ")}`.toLowerCase().includes(s));
  }
  if (qy.usesChip) {
    const s = qy.usesChip.toLowerCase();
    list = list.filter((m) => String(m.main_chip || "").toLowerCase().includes(s));
  }
  if (qy.interfaceType) {
    const t = qy.interfaceType.toUpperCase();
    list = list.filter((m) => m.interfaces?.some((i: any) => i.interface_type === t));
  }
  if (qy.vAtLeast != null) list = list.filter((m) => m.interfaces?.some((i: any) => (i.voltage_level ?? 0) >= qy.vAtLeast!));
  if (qy.vAtMost != null) list = list.filter((m) => m.interfaces?.some((i: any) => i.voltage_level != null && i.voltage_level <= qy.vAtMost!));
  if (qy.fiveVTolerant != null) list = list.filter((m) => m.interfaces?.some((i: any) => !!i.five_v_tolerant === qy.fiveVTolerant));
  const peak = (m: any) => m.power?.peak_current_ma ?? m.power?.typical_current_ma ?? 0;
  if (qy.minPeakMa != null) list = list.filter((m) => peak(m) >= qy.minPeakMa!);
  if (qy.maxPeakMa != null) list = list.filter((m) => peak(m) <= qy.maxPeakMa!);

  let annotated = list.map((m) => ({ ...m, _completeness: scoreCompleteness(m).score }));
  if (qy.minCompleteness != null) annotated = annotated.filter((m) => m._completeness >= qy.minCompleteness!);
  annotated.sort((a, b) => b._completeness - a._completeness);
  return annotated.slice(0, qy.limit ?? 100);
}

/* ------------------------------ 治理报告 ------------------------------ */

export interface GovernanceReport {
  totalModules: number;
  averageCompleteness: number;
  lowCompleteness: { id: string; name: string; score: number; missing: string[] }[];
  pendingReview: { id: string; name: string; source: string }[];   // DRAFT 待审核
  byStatus: { status: string; count: number }[];
  bySource: { source: string; count: number }[];
}

export async function governanceReport(
  lowThreshold = 60,
  vis?: { viewerRef?: string | null; orgRef?: string | null },
): Promise<GovernanceReport> {
  await ensureSchema();
  // 治理统计同样不得跨组织泄露：org_admin 只应看到本组织数据
  const v = visibilityClause(vis?.orgRef, vis?.viewerRef);
  const rs = await db().execute({
    sql: `SELECT id, data, certification_status, source_type FROM modules WHERE ${v.sql}`,
    args: v.args,
  });
  const rows = rs.rows.map((r) => ({
    m: JSON.parse(String(r.data)),
    status: String(r.certification_status),
    source: String(r.source_type || "unknown"),
  }));

  let sum = 0;
  const low: GovernanceReport["lowCompleteness"] = [];
  const pending: GovernanceReport["pendingReview"] = [];
  const byStatus: Record<string, number> = {};
  const bySource: Record<string, number> = {};

  for (const { m, status, source } of rows) {
    const c = scoreCompleteness(m);
    sum += c.score;
    if (c.score < lowThreshold) low.push({ id: m.id, name: m.name, score: c.score, missing: c.missing.slice(0, 6) });
    if (status === "DRAFT") pending.push({ id: m.id, name: m.name, source });
    byStatus[status] = (byStatus[status] || 0) + 1;
    bySource[source] = (bySource[source] || 0) + 1;
  }
  low.sort((a, b) => a.score - b.score);
  return {
    totalModules: rows.length,
    averageCompleteness: rows.length ? Math.round(sum / rows.length) : 0,
    lowCompleteness: low,
    pendingReview: pending,
    byStatus: Object.entries(byStatus).map(([status, count]) => ({ status, count })),
    bySource: Object.entries(bySource).map(([source, count]) => ({ source, count })),
  };
}

/* ------------------------------ 审计日志 ------------------------------ */

export async function audit(action: string, moduleId: string, actor: string) {
  try {
    await db().execute({
      sql: "INSERT INTO events (event_type, task_id, payload) VALUES ('module_audit', ?, ?)",
      args: [moduleId, JSON.stringify({ action, actor, at: new Date().toISOString() })],
    });
  } catch { /* 审计失败不阻塞主流程 */ }
}
