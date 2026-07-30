import { NextRequest, NextResponse } from "next/server";
import { resolveTier } from "@/lib/auth";
import {
  getVersionContent, getDraftVersion, getPublishedVersion, saveExtraction,
  createDraftVersion, publicationChecklist, addReview, deleteProblem,
} from "@/lib/problem-center";
import { db, ensureSchema } from "@/lib/db";

export const runtime = "nodejs";
const isStaff = (t: string) => t === "admin" || t === "lab";

/** GET ?version_id= 指定版本；默认工作人员看草稿、用户看已发布 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const tier = resolveTier(req);
  const staff = isStaff(tier);
  const sp = new URL(req.url).searchParams;

  let versionId = sp.get("version_id");
  if (!versionId) {
    const v = staff ? (await getDraftVersion(params.id)) || (await getPublishedVersion(params.id))
                    : await getPublishedVersion(params.id);
    if (!v) return NextResponse.json({ error: staff ? "题目还没有任何版本" : "该题目尚未发布" }, { status: 404 });
    versionId = String((v as any).version_id);
  }

  const content = await getVersionContent(versionId);
  if (!content) return NextResponse.json({ error: "版本不存在" }, { status: 404 });
  if (String(content.version.status) !== "published" && !staff) {
    return NextResponse.json({ error: "该版本尚未发布" }, { status: 403 });
  }
  // 题面原文受版权保护，不下发给普通用户
  if (!staff) delete (content.version as any).raw_text;

  const checklist = staff ? await publicationChecklist(versionId) : null;
  // 结构化歧义（含候选解释与决策），供前端渲染决策入口
  const { getAmbiguities } = await import("@/lib/problem-center");
  const { canAdoptSolution } = await import("@/lib/ambiguity");
  const ambiguities = await getAmbiguities(versionId);
  const gate = canAdoptSolution(ambiguities);
  return NextResponse.json({
    ...content, checklist,
    ambiguities: staff ? ambiguities : ambiguities.filter((a) => a.resolved),
    ambiguity_gate: { ok: gate.ok, blocking: gate.blocking.length, pending_normal: gate.pendingNormal },
  });
}

/** PATCH：编辑草稿内容 / 确认需求 / 新建版本 / 提交审核 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const tier = resolveTier(req);
  if (!isStaff(tier)) return NextResponse.json({ error: "仅工作人员可编辑" }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  await ensureSchema();

  // 开新版本（已发布版本不可改）
  if (b.action === "new_version") {
    const vid = await createDraftVersion(params.id, { rawText: b.raw_text });
    return NextResponse.json({ version_id: vid }, { status: 201 });
  }

  const versionId: string | undefined = b.version_id;
  if (!versionId) return NextResponse.json({ error: "需要 version_id" }, { status: 400 });

  // 逐条确认/驳回需求
  if (b.action === "confirm_requirement") {
    await db().execute({
      sql: `UPDATE problem_requirements SET status=?, confirmed_by=?, confirmed_at=now()
            WHERE version_id=? AND requirement_no=?`,
      args: [b.status === "REJECTED" ? "REJECTED" : "CONFIRMED", tier, versionId, b.requirement_no],
    });
    return NextResponse.json({ ok: true });
  }
  if (b.action === "confirm_all") {
    // 一键确认不得覆盖有阻断错误的需求 —— 学生测试中
    // 「1Hz~1MHzHz」「≤1%%」这类解析错误被一并确认后，
    // 会传播到方案、BOM、代码与报告，且「已确认」失去可信含义
    const { validateRequirements } = await import("@/lib/requirement-validate");
    const all = await db().execute({
      sql: `SELECT req_id, requirement_no, description, type, target, unit, tolerance,
              source_quote, source_page, status
            FROM problem_requirements WHERE version_id=? ORDER BY sort_order`,
      args: [versionId],
    });
    const rows = all.rows as any[];
    const { byIndex, blockingIndexes } = validateRequirements(rows);

    if (blockingIndexes.length && b.force !== true) {
      return NextResponse.json({
        error: `${blockingIndexes.length} 条需求存在必须先修正的错误，不能批量确认`,
        blocking: blockingIndexes.map((i) => ({
          requirement_no: rows[i].requirement_no,
          description: String(rows[i].description || "").slice(0, 60),
          issues: (byIndex.get(i) || []).filter((x) => x.severity === "error").map((x) => x.message),
        })),
      }, { status: 422 });
    }

    // 只确认没有阻断错误的那些；有错误的保持待确认，除非显式 force
    const skip = new Set(blockingIndexes.map((i) => String(rows[i].req_id)));
    const targets = rows
      .filter((r) => !["CONFIRMED", "REJECTED"].includes(String(r.status)))
      .filter((r) => b.force === true || !skip.has(String(r.req_id)));

    for (const r of targets) {
      await db().execute({
        sql: `UPDATE problem_requirements SET status='CONFIRMED', confirmed_by=?, confirmed_at=now()
              WHERE req_id=?`,
        args: [tier, r.req_id],
      });
    }
    return NextResponse.json({ ok: true, confirmed: targets.length, skipped: skip.size });
  }
  if (b.action === "resolve_note") {
    // 歧义必须记录一项具体决策，而不是简单标记「已人工处理」——
    // 学生测试指出：只有文本提示、没有决策入口时，题意悬空会一路影响下游
    const { decideAmbiguity } = await import("@/lib/problem-center");
    const decision = b.decision ?? (b.resolution ? { kind: "custom", note: String(b.resolution) } : null);
    if (!decision) {
      return NextResponse.json({
        error: "需要给出决策：采用某项解释 / 自定义解释 / 保持开放（并说明保守假设）/ 需询问指导教师",
      }, { status: 400 });
    }
    const r = await decideAmbiguity(String(b.note_id), decision, `admin:${tier}`);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 422 });
    return NextResponse.json({ ok: true });
  }
  if (b.action === "review") {
    await addReview(versionId, b.reviewer || tier, b.decision === "reject" ? "reject" : "approve", b.note);
    return NextResponse.json({ ok: true });
  }

  // 覆盖式保存提取结果
  try {
    await saveExtraction(versionId, {
      requirements: b.requirements, scoringItems: b.scoring_items,
      ambiguities: b.ambiguities, rawText: b.raw_text,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}


export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isStaff(resolveTier(req))) {
    return NextResponse.json({ error: "需要工作人员权限" }, { status: 403 });
  }
  // 已发布或已被项目引用的题目需显式 force，避免误删导致引用方失去需求来源
  const force = new URL(req.url).searchParams.get("force") === "1";
  const r = await deleteProblem(params.id, { force });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
  return NextResponse.json(r);
}
