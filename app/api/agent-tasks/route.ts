import { NextRequest, NextResponse } from "next/server";
import { resolveOwner, assertProjectAccess } from "@/lib/auth";
import { getRequestIdentity } from "@/lib/identity";
import { db, ensureSchema, uid } from "@/lib/db";
import type { AgentType } from "@/lib/types";
import { AGENT_TYPES } from "@/lib/types";

export const runtime = "nodejs";

/** 任务层（与 agent_runs 执行日志分离）：
 *  POST 建任务（幂等键去重）；GET ?project_id=&active=1 列活动任务（刷新恢复用）。 */
export async function POST(req: NextRequest) {
  const id = await getRequestIdentity(req);
  const tier = id.tier;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 }); }

  const agent = body.agent as AgentType;
  if (!AGENT_TYPES.includes(agent)) return NextResponse.json({ error: `未知 agent` }, { status: 400 });
  const paidAgents: AgentType[] = ["code_generator", "report_composer", "labsight_debug"];
  if (tier === "free" && paidAgents.includes(agent)) return NextResponse.json({ error: "该能力需要付费账户。" }, { status: 402 });

  await ensureSchema();
  const projectId: string | null = body.project_id || null;
  if (projectId) {
    const denied = await assertProjectAccess(req, projectId);
    if (denied) return denied;
  }

  // 并发去重：同项目同 Agent 已有活动任务 → 直接返回该任务（防止连点两下并行烧两次 LLM）
  if (projectId) {
    const act = await db().execute({
      sql: "SELECT task_id, status FROM agent_tasks WHERE project_id=? AND agent_type=? AND status IN ('queued','running') LIMIT 1",
      args: [projectId, agent],
    });
    if (act.rows.length) return NextResponse.json({ task_id: act.rows[0].task_id, status: act.rows[0].status, deduped: true }, { status: 200 });
  }

  // 幂等：同 key 已有任务直接返回，防重复扣费
  if (body.idempotency_key) {
    const ex = await db().execute({ sql: "SELECT task_id, status FROM agent_tasks WHERE idempotency_key=?", args: [body.idempotency_key] });
    if (ex.rows.length) return NextResponse.json({ task_id: ex.rows[0].task_id, status: ex.rows[0].status, deduped: true }, { status: 200 });
  }

  // taskType 与优先级来自策略表；inputHash 用于相同输入直接复用已有任务
  const { AGENT_TASK_TYPE, policyFor } = await import("@/lib/model-gateway/task-policy");
  const { modelGateway } = await import("@/lib/model-gateway");
  const taskType = AGENT_TASK_TYPE[agent] || "GENERAL_QA";
  const policy = policyFor(taskType as any);
  const hash = modelGateway.inputHash(taskType, { input: body.input || {}, project: projectId });

  // 相同 inputHash 的近期任务直接复用（防重复扣费）
  const dup = await db().execute({
    sql: `SELECT task_id, status FROM agent_tasks
          WHERE input_hash=? AND created_at > now() - interval '10 minutes'
            AND status IN ('queued','running','ok') ORDER BY created_at DESC LIMIT 1`,
    args: [hash],
  }).catch(() => ({ rows: [] as any[] }));
  if (dup.rows.length) {
    return NextResponse.json({ task_id: dup.rows[0].task_id, status: dup.rows[0].status, deduped: true, reason: "input_hash" }, { status: 200 });
  }

  // 每用户重型任务并发上限
  const { getPeakConfig } = await import("@/lib/system-mode");
  const peak = await getPeakConfig();
  if (policy.concurrencyClass === "heavy") {
    const running = await db().execute({
      sql: `SELECT COUNT(*) n FROM agent_tasks WHERE owner_ref=? AND status IN ('queued','running')
              AND task_type IN (SELECT unnest(?::text[]))`,
      args: [id.owner, `{${Object.entries(AGENT_TASK_TYPE).filter(([, t]) => policyFor(t as any).concurrencyClass === "heavy").map(([, t]) => t).join(",")}}`],
    }).catch(() => ({ rows: [{ n: 0 }] as any[] }));
    if (Number(running.rows[0]?.n || 0) >= peak.maxPerUserConcurrency) {
      return NextResponse.json({
        error: `你已有 ${running.rows[0].n} 个生成任务在进行中，请等待完成后再提交（每人同时最多 ${peak.maxPerUserConcurrency} 个重型任务）。`,
      }, { status: 429 });
    }
  }

  // 系统模式门禁：降级/仅规则模式下明确拒绝并说明仍可用的能力
  const { getSystemMode, allowsPriority } = await import("@/lib/system-mode");
  const mode = await getSystemMode();
  const gate = allowsPriority(mode, policy.priority);
  if (!gate.allowed) {
    return NextResponse.json({ error: gate.reason, system_mode: mode, degraded: true }, { status: 503 });
  }

  // 配额预占与任务绑定：任务终态时统一 commit/refund，Worker 崩溃也不会重复扣费
  const taskId = uid("TASK");
  let quotaRef: string | null = null;
  const quotaKind = policy.costClass === "high" ? "heavy_task" : null;
  if (quotaKind) {
    const { reserveQuota } = await import("@/lib/usage");
    const { reservation, error: qerr } = await reserveQuota(id.owner, quotaKind, tier);
    if (!reservation) return NextResponse.json({ error: qerr }, { status: 429 });
    quotaRef = reservation.ref;
  }
  // 模型名不在建单时臆测（选路由网关在执行时决定，可能容灾切换）——执行完成后回写实际值
  const model: string | null = null;
  await db().execute({
    sql: `INSERT INTO agent_tasks (task_id, project_id, agent_type, status, input, tier, idempotency_key, model,
            task_type, priority, input_hash, owner_ref, org_ref, queue_name, quota_ref, quota_kind, scheduled_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, now())`,
    args: [taskId, projectId, agent, "queued", JSON.stringify(body.input || {}), tier, body.idempotency_key || null, model,
      taskType, policy.priority, hash, id.owner, id.org, policy.concurrencyClass, quotaRef, quotaKind],
  });
  return NextResponse.json({ task_id: taskId, status: "queued", model }, { status: 202 });
}

export async function GET(req: NextRequest) {
  await ensureSchema();
  const sp = new URL(req.url).searchParams;
  const projectId = sp.get("project_id");
  if (!projectId) return NextResponse.json({ error: "缺少 project_id" }, { status: 400 });
  const denied = await assertProjectAccess(req, projectId);
  if (denied) return denied;
  const active = sp.get("active") === "1";
  const rs = await db().execute({
    sql: active
      ? "SELECT task_id, agent_type, status, attempts, created_at FROM agent_tasks WHERE project_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 10"
      : "SELECT task_id, agent_type, status, attempts, error, created_at FROM agent_tasks WHERE project_id=? ORDER BY created_at DESC LIMIT 30",
    args: [projectId],
  });
  return NextResponse.json({ tasks: rs.rows });
}
