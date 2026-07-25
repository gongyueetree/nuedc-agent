import { AsyncLocalStorage } from "node:async_hooks";
import { db, uid, ensureSchema } from "../db";
import type { AgentType, ProjectStage } from "../types";
import { STAGE_ALLOWED_AGENTS } from "../types";

export interface AgentContext {
  owner?: string | null;
  /** 组织标识，决定该次运行能看到哪些私有模块 */
  org?: string | null;
  orgRole?: string | null;
  taskId?: string | null;
  projectId: string | null;
  stage: ProjectStage;
  tier: string;
}

export interface AgentResult {
  ok: boolean;
  artifact_type?: string;
  output: unknown;
  human_review_required?: boolean;
  message?: string;
}

export type AgentFn = (input: any, ctx: AgentContext) => Promise<AgentResult>;

const registry = new Map<AgentType, AgentFn>();

export function registerAgent(type: AgentType, fn: AgentFn) {
  registry.set(type, fn);
}

/** Agent 运行上下文。
 *  必须用 AsyncLocalStorage：模块级变量在同一 Node 实例并发处理多请求时会串用户、
 *  把 A 用户的 token 用量记到 B 用户的项目上。ALS 保证每条异步调用链各自隔离。 */
export interface AgentRunContext {
  owner?: string | null;
  org?: string | null;
  orgRole?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  agent?: string;
  /** 本次运行中网关是否返回过 partial 结果（截断后修复）。
   *  放在 ALS 上下文里而非模块级变量，避免并发串线。 */
  partialSeen?: { value: boolean };
}

const agentContextStore = new AsyncLocalStorage<AgentRunContext>();

/** 读取当前调用链的上下文；不在 Agent 执行链中时返回空对象（退化为不记账，绝不串线） */
export function currentAgentContext(): AgentRunContext {
  return agentContextStore.getStore() ?? {};
}

/** 在隔离的上下文中执行 —— 所有 Agent 执行必须经此包裹 */
export function withAgentContext<T>(ctx: AgentRunContext, fn: () => Promise<T>): Promise<T> {
  return agentContextStore.run(ctx, fn);
}

/** 执行 Agent。整个调用链在独立的 AsyncLocalStorage 上下文中运行，
 *  确保并发请求之间的 owner/project/task 绝不互相污染。 */
export function runAgent(
  type: AgentType,
  input: any,
  ctx: AgentContext
): Promise<AgentResult & { run_id: string }> {
  return withAgentContext(
    { owner: ctx.owner ?? null, org: ctx.org ?? null, orgRole: ctx.orgRole ?? null,
      projectId: ctx.projectId, taskId: ctx.taskId ?? null, agent: type,
      partialSeen: { value: false } },
    () => runAgentInner(type, input, ctx),
  );
}

async function runAgentInner(
  type: AgentType,
  input: any,
  ctx: AgentContext
): Promise<AgentResult & { run_id: string }> {
  await ensureSchema();
  const runId = uid("RUN");
  const t0 = Date.now();


  // 状态门禁：项目状态机决定允许调用哪些 Agent
  const allowed = STAGE_ALLOWED_AGENTS[ctx.stage] || [];
  if (ctx.projectId && !allowed.includes(type)) {
    const result: AgentResult = {
      ok: false,
      output: null,
      message: `项目当前阶段 ${ctx.stage} 不允许调用 ${type}。允许的 Agent：${allowed.join("、")}`,
    };
    await logRun(runId, ctx, type, input, result, Date.now() - t0, "blocked_by_stage");
    return { ...result, run_id: runId };
  }

  const fn = registry.get(type);
  if (!fn) {
    return { ok: false, output: null, message: `未知 Agent：${type}`, run_id: runId };
  }

  try {
    const result = await fn(input, ctx);
    await logRun(runId, ctx, type, input, result, Date.now() - t0, "ok");
    // Artifact 落库：版本递增 + 方案变更自动级联失效下游
    if (result.ok && result.artifact_type) {
      const { saveArtifact } = await import("../artifacts");
      const { AGENT_CONSUMES } = await import("../artifact-graph");
      // 实例级溯源：查本 Agent 消费的上游类型当前最新版本 id
      let sourceIds: string[] = [];
      if (ctx.projectId && AGENT_CONSUMES[type]?.length) {
        const placeholders = AGENT_CONSUMES[type].map(() => "?").join(",");
        const rs = await db().execute({
          sql: `SELECT a.artifact_id FROM artifacts a
                JOIN (SELECT type, MAX(version) v FROM artifacts WHERE project_id=? AND type IN (${placeholders}) GROUP BY type) m
                ON a.type=m.type AND a.version=m.v WHERE a.project_id=?`,
          args: [ctx.projectId, ...AGENT_CONSUMES[type], ctx.projectId],
        });
        sourceIds = rs.rows.map((r) => String(r.artifact_id));
      }
      await saveArtifact({
        projectId: ctx.projectId, type: result.artifact_type, content: result.output,
        createdBy: type, status: result.human_review_required ? "draft" : "reviewed",
        sourceArtifactIds: sourceIds, changeReason: `run:${type}`,
      });
    }
    return { ...result, run_id: runId };
  } catch (e: any) {
    const result: AgentResult = { ok: false, output: null, message: e?.message || String(e) };
    await logRun(runId, ctx, type, input, result, Date.now() - t0, "error");
    return { ...result, run_id: runId };
  }
}

async function logRun(
  runId: string,
  ctx: AgentContext,
  type: AgentType,
  input: any,
  result: AgentResult,
  ms: number,
  status: string
) {
  try {
    await db().execute({
      sql: `INSERT INTO agent_runs (run_id, project_id, agent_type, objective, input, output, status, duration_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        runId,
        ctx.projectId,
        type,
        input?.objective ?? "",
        JSON.stringify(input).slice(0, 20000),
        JSON.stringify(result.output ?? result.message ?? "").slice(0, 100000),
        status,
        ms,
      ],
    });
  } catch { /* 日志失败不阻断主流程 */ }
}

/** 从模块表构造检索上下文（给需要模块知识的 Agent 用）。
 *  可见范围 fail-closed：不传 vis 时只返回公共模块 ——
 *  私有模块绝不能因为某个 Agent 忘了传参就进入 LLM 上下文。 */
export async function loadModuleIndex(
  limit = 200,
  vis?: { viewerRef?: string | null; orgRef?: string | null },
): Promise<Record<string, any>> {
  await ensureSchema();
  const { visibilityClause } = await import("../module-query");
  const v = visibilityClause(vis?.orgRef, vis?.viewerRef);
  const rs = await db().execute({
    sql: `SELECT id, data, scope, owner_ref, org_ref FROM modules
          WHERE certification_status != 'DEPRECATED' AND ${v.sql} LIMIT ?`,
    args: [...v.args, limit],
  });
  const index: Record<string, any> = {};
  for (const row of rs.rows) {
    try {
      const m = JSON.parse(String(row.data));
      // 归属以数据库列为准，供检索层按组织加权
      m.scope = row.scope ? String(row.scope) : "PUBLIC";
      m.owner_ref = row.owner_ref ? String(row.owner_ref) : null;
      m.org_ref = row.org_ref ? String(row.org_ref) : null;
      index[String(row.id)] = m;
    } catch { /* skip */ }
  }
  return index;
}

/** 给 LLM 的精简模块目录（控制 token） */
/** 模块目录 → 提示词文本。
 *  库大了会挤占输出预算导致截断，因此按相关性裁剪：
 *  优先模块置顶，其余按认证等级排序，超过 limit 条则截断并注明。 */
export function moduleCatalogForLlm(
  index: Record<string, any>,
  opts: { preferred?: string[]; limit?: number } = {}
): string {
  const limit = opts.limit ?? 40;
  const CERT_RANK: Record<string, number> = {
    COMPETITION_READY: 0, BENCHMARKED: 1, FUNCTION_TESTED: 2,
    POWER_TESTED: 3, DOCUMENTED: 4, DRAFT: 5, DEPRECATED: 9,
  };
  const preferred = new Set(opts.preferred || []);
  const all = Object.values(index) as any[];
  const sorted = [...all].sort((a, b) => {
    const pa = preferred.has(a.id) ? 0 : 1, pb = preferred.has(b.id) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return (CERT_RANK[a.certification_status] ?? 6) - (CERT_RANK[b.certification_status] ?? 6);
  });
  const shown = sorted.slice(0, limit);
  const omitted = all.length - shown.length;
  const body = shown
    .map((m: any) => {
      const ifaces = (m.interfaces || [])
        .map((i: any) => `${i.name}:${i.interface_type}@${i.voltage_level ?? "?"}V`)
        .join(",");
      const power = m.power
        ? `供电${(m.power.input_voltage_range || []).join("-")}V/典型${m.power.typical_current_ma ?? "?"}mA/峰值${m.power.peak_current_ma ?? "?"}mA`
        : "";
      return `- id=${m.id} | ${m.name} | ${m.category} | 芯片:${m.main_chip ?? "?"} | 接口:[${ifaces}] | ${power} | 认证:${m.certification_status}`;
    })
    .join("\n");
  return omitted > 0 ? `${body}\n（另有 ${omitted} 个模块未列出，如需其他器件可将 module_id 留空并在 name 中说明）` : body;
}


/** 标记本次 Agent 运行收到过不完整（截断修复）的模型输出 */
export function markPartial(): void {
  const c = currentAgentContext();
  if (c.partialSeen) c.partialSeen.value = true;
}

/** 本次 Agent 运行是否出现过 partial 输出 */
export function sawPartial(): boolean {
  return currentAgentContext().partialSeen?.value === true;
}
