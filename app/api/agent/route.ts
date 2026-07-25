import { NextRequest, NextResponse } from "next/server";
import "@/lib/agents/index";
import { runAgent } from "@/lib/agents/base";
import { getRequestIdentity } from "@/lib/identity";
import { db, ensureSchema } from "@/lib/db";
import type { AgentType, ProjectStage } from "@/lib/types";
import { AGENT_TYPES } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function OPTIONS() { return new NextResponse(null, { status: 204 }); }

export async function POST(req: NextRequest) {
  const identity = await getRequestIdentity(req);
  const tier = identity.tier;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 }); }

  const agent = body.agent as AgentType;
  if (!AGENT_TYPES.includes(agent)) {
    return NextResponse.json({ error: `未知 agent，可选：${AGENT_TYPES.join(", ")}` }, { status: 400 });
  }

  // 免费用户限制：代码生成 / 报告生成 / 调试属付费能力
  const paidAgents: AgentType[] = ["code_generator", "report_composer", "labsight_debug"];
  if (tier === "free" && paidAgents.includes(agent)) {
    return NextResponse.json({ error: "该能力需要付费账户。免费账户可用：赛题分析、模块浏览、方案建议。" }, { status: 402 });
  }

  // 读取项目阶段（用于状态门禁）
  let stage: ProjectStage = "PREPARATION";
  const projectId: string | null = body.project_id || null;
  if (projectId) {
    await ensureSchema();
    const rs = await db().execute({ sql: "SELECT stage FROM projects WHERE project_id=?", args: [projectId] });
    if (rs.rows.length) stage = String(rs.rows[0].stage) as ProjectStage;
  }

  const result = await runAgent(agent, body.input || {}, { projectId, stage, tier, owner: identity.owner, org: identity.org, orgRole: identity.orgRole });
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}
