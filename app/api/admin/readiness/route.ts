import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema, dbDriver } from "@/lib/db";
import { resolveTier } from "@/lib/auth";
import { workerStatus, workerMetrics, WORKER_LIVE_WINDOW_SEC } from "@/lib/task-queue";
import { configuredProviders } from "@/lib/model-gateway";
import { getSystemMode } from "@/lib/system-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 就绪度详情：压测前置检查用。
 *  与 /api/ready 的区别：这里给出可用于断言的结构化指标
 *  （Worker 存活数、队列深度、迁移版本、Provider 配置），
 *  压测脚本据此判断"现在跑压测有没有意义"。 */
export async function GET(req: NextRequest) {
  // 含运行拓扑信息，仅管理员可见
  if (resolveTier(req) !== "admin") {
    return NextResponse.json({ error: "需要管理员身份" }, { status: 403 });
  }

  const out: Record<string, any> = { ok: true };

  try {
    await ensureSchema();
    const mig = await db().execute({ sql: "SELECT COUNT(*) n, MAX(id) latest FROM schema_migrations", args: [] });
    out.database = {
      ok: true,
      driver: dbDriver(),
      migrations_applied: Number((mig.rows[0] as any)?.n || 0),
      latest_migration: Number((mig.rows[0] as any)?.latest || 0),
    };
  } catch (e: any) {
    out.database = { ok: false, error: String(e?.message || e).slice(0, 200) };
    out.ok = false;
  }

  // fail-closed：查询失败 ≠ 没有 Worker。把异常伪装成 live=0 会让压测/部署
  // 误判为"环境正常但无 Worker"，掩盖真正的数据库故障。
  try {
    out.workers = { ok: true, ...(await workerStatus()), live_window_sec: WORKER_LIVE_WINDOW_SEC };
  } catch (e: any) {
    out.workers = { ok: false, error: String(e?.message || e).slice(0, 200) };
    out.ok = false;
  }

  try {
    out.worker_metrics = await workerMetrics();
  } catch (e: any) {
    out.worker_metrics = { _error: String(e?.message || e).slice(0, 160) };
  }

  try {
    const q = await db().execute({
      sql: `SELECT status, COUNT(*) n FROM agent_tasks
            WHERE created_at > now() - interval '2 hours' GROUP BY status`,
      args: [],
    });
    const by: Record<string, number> = {};
    for (const r of q.rows as any[]) by[String(r.status)] = Number(r.n);
    out.queue = {
      ok: true,
      queued: by.queued || 0, running: by.running || 0,
      succeeded: by.ok || 0, failed: by.error || 0, dead: by.dead || 0,
      backlog: (by.queued || 0) + (by.running || 0),
    };
  } catch (e: any) {
    // 同上：queue=null 会被消费方当成"队列为空"
    out.queue = { ok: false, error: String(e?.message || e).slice(0, 200) };
    out.ok = false;
  }

  const providers = configuredProviders();
  out.providers = {
    configured: providers,
    mock_enabled: process.env.ENABLE_MOCK_PROVIDER === "1",
    count: providers.length,
  };
  out.system_mode = await getSystemMode();
  out.inline_execute_allowed = process.env.ALLOW_INLINE_EXECUTE === "1";

  return NextResponse.json(out, { status: out.ok ? 200 : 503 });
}
