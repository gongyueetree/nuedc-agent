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
  return NextResponse.json({ ...content, checklist });
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
    await db().execute({
      sql: `UPDATE problem_requirements SET status='CONFIRMED', confirmed_by=?, confirmed_at=now()
            WHERE version_id=? AND status NOT IN ('CONFIRMED','REJECTED')`,
      args: [tier, versionId],
    });
    return NextResponse.json({ ok: true });
  }
  if (b.action === "resolve_note") {
    await db().execute({
      sql: "UPDATE problem_notes SET resolved=1, resolution=? WHERE note_id=?",
      args: [String(b.resolution || "已人工处理").slice(0, 300), b.note_id],
    });
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
