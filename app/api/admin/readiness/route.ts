import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema, dbDriver } from "@/lib/db";
import { resolveTier } from "@/lib/auth";
import { workerStatus, WORKER_LIVE_WINDOW_SEC } from "@/lib/task-queue";
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

  const out: Record<string, any> = { ok: true, checks: {} };

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

  try {
    out.workers = { ...(await workerStatus()), live_window_sec: WORKER_LIVE_WINDOW_SEC };
  } catch {
    out.workers = { live: 0, total: 0, capacity: { heavy: 0, light: 0 }, inFlight: 0, workers: [] };
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
      queued: by.queued || 0, running: by.running || 0,
      ok: by.ok || 0, error: by.error || 0, dead: by.dead || 0,
      backlog: (by.queued || 0) + (by.running || 0),
    };
  } catch {
    out.queue = null;
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
