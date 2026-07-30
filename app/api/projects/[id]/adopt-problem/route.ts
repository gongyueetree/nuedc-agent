import { NextRequest, NextResponse } from "next/server";
import { assertProjectAccess } from "@/lib/auth";
import { getPublishedVersion, getVersionContent } from "@/lib/problem-center";
import { saveArtifact } from "@/lib/artifacts";
import { db, ensureSchema } from "@/lib/db";

export const runtime = "nodejs";

/** 项目采用官方题目：直接复制已发布的结构化需求与评分项。
 *  全程不调用任何模型 —— 这是"同一题目只解析一次"的落地点。 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await assertProjectAccess(req, params.id);
  if (denied) return denied;
  const { problem_id } = await req.json().catch(() => ({}));
  if (!problem_id) return NextResponse.json({ error: "需要 problem_id" }, { status: 400 });

  const pv: any = await getPublishedVersion(problem_id);
  if (!pv) return NextResponse.json({ error: "该题目尚未发布" }, { status: 409 });

  // 关键歧义未决时不允许采用为项目需求 —— 悬空的题意会一路影响
  // 方案、BOM、代码与评分，而学生往往不会回头核对
  const { getAmbiguities } = await import("@/lib/problem-center");
  const { canAdoptSolution } = await import("@/lib/ambiguity");
  const ambs = await getAmbiguities(String(pv.version_id));
  const gate = canAdoptSolution(ambs);
  if (!gate.ok) {
    return NextResponse.json({
      error: `该题目有 ${gate.blocking.length} 项关键题意待澄清，工作人员确认后才能采用`,
      blocking_ambiguities: gate.blocking.map((a) => ({
        content: a.content,
        options: a.options.map((o) => `${o.key}. ${o.text}`),
      })),
    }, { status: 409 });
  }
  const content = await getVersionContent(String(pv.version_id));
  if (!content) return NextResponse.json({ error: "版本内容缺失" }, { status: 404 });
  const p: any = content.version;

  await ensureSchema();
  await db().execute({
    sql: `UPDATE projects SET problem_id=?, problem_version=?, problem_version_id=?, name=?,
            stage='REQUIREMENTS_PARSED', updated_at=now() WHERE project_id=?`,
    args: [problem_id, Number(pv.version_no), String(pv.version_id),
      `${p.year} 年 ${p.code} 题 · ${p.title}`, params.id],
  });

  // 需求进入项目产物（用户仍需逐条确认，但不消耗模型）
  // 只取已确认的需求；驳回项不进入用户项目
  const activeReqs = content.requirements
    .filter((r: any) => String(r.status) !== "REJECTED")
    .map((r: any) => ({
      id: r.requirement_no, type: r.type, description: r.description,
      target: r.target, unit: r.unit, tolerance: r.tolerance, priority: r.priority,
      verification_method: r.verification_method,
      source: r.source_quote, source_page: r.source_page,
      status: "CONFIRMED",       // 官方题目已由工作人员确认
    }));

  const artifactContent = {
    project_name: `${p.year} 年 ${p.code} 题：${p.title}`,
    system_overview: "",
    requirements: activeReqs,
    scoring_items: content.scoring_items.map((s: any) => ({
      item: s.item, points: s.points != null ? Number(s.points) : null,
      points_type: s.points_type, requirement_ids: s.requirement_ids, source_page: s.source_page,
    })),
    ambiguities: content.notes.filter((n: any) => String(n.kind) === "ambiguity" && !n.resolved).map((n: any) => n.content),
    source: { problem_id, problem_version_id: String(pv.version_id), version_no: Number(pv.version_no), official: true },
  };
  const saved = await saveArtifact({
    projectId: params.id, type: "requirements", content: artifactContent,
    createdBy: "official_problem",
    changeReason: `采用官方题目 ${p.year}-${p.code} v${pv.version_no}（不可变版本 ${pv.version_id}）`,
  });

  return NextResponse.json({
    ok: true, ...saved,
    version_id: String(pv.version_id), version_no: Number(pv.version_no),
    requirements: activeReqs.length,
    scoring_items: artifactContent.scoring_items.length,
    llm_calls: 0,
  }, { status: 201 });
}
