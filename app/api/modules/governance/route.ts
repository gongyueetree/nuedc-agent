import { NextRequest, NextResponse } from "next/server";
import { resolveTier } from "@/lib/auth";
import { governanceReport } from "@/lib/module-query";

export const runtime = "nodejs";

/** GET /api/modules/governance —— 编辑后台治理总览（lab/admin） */
export async function GET(req: NextRequest) {
  const { getRequestIdentity } = await import("@/lib/identity");
  const identity = await getRequestIdentity(req);
  const tier = resolveTier(req);
  if (!["lab", "admin"].includes(tier)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  const report = await governanceReport(Number(new URL(req.url).searchParams.get("low")) || 60);
  return NextResponse.json(report);
}
