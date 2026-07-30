import { NextRequest, NextResponse } from "next/server";
import { resolveTier } from "@/lib/auth";
import { getSystemMode, setSystemMode, getPeakConfig, SYSTEM_MODES, MODE_LABEL, type SystemMode } from "@/lib/system-mode";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/** 系统模式：公开可读（前端据此显示降级提示），仅管理员可写 */
export async function GET() {
  const mode = await getSystemMode();
  const peak = await getPeakConfig();
  let queued = 0;
  try {
    // 不调 ensureSchema：这是高频轮询端点，每次执行补列语句会持续消耗
    // 数据库传输配额（Neon 免费版曾因此耗尽额度）。schema 由其它路径保证。
    const rs = await db().execute({ sql: "SELECT COUNT(*) n FROM agent_tasks WHERE status IN ('queued','running')", args: [] });
    queued = Number(rs.rows[0]?.n || 0);
  } catch { /* 忽略 */ }
  return NextResponse.json({
    mode, label: MODE_LABEL[mode], modes: SYSTEM_MODES,
    queue_length: queued,
    peak_warning: queued >= (peak.queueWarningThreshold || 20),
    max_per_user_concurrency: peak.maxPerUserConcurrency,
  });
}

export async function POST(req: NextRequest) {
  if (resolveTier(req) !== "admin") return NextResponse.json({ error: "需要管理员身份" }, { status: 403 });
  const { mode } = await req.json().catch(() => ({}));
  if (!SYSTEM_MODES.includes(mode)) return NextResponse.json({ error: `mode 必须是 ${SYSTEM_MODES.join("/")}` }, { status: 400 });
  await setSystemMode(mode as SystemMode);
  return NextResponse.json({ ok: true, mode });
}
