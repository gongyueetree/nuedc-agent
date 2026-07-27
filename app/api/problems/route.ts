import { NextRequest, NextResponse } from "next/server";
import { resolveTier } from "@/lib/auth";
import { listProblems, createProblem, createDraftVersion, findVersionByPdf, pdfSha256, problemFacets } from "@/lib/problem-center";

export const runtime = "nodejs";

const isStaff = (t: string) => t === "admin" || t === "lab";

/** GET：普通用户只见已发布题目；工作人员可见全部 */
export async function GET(req: NextRequest) {
  const staff = isStaff(resolveTier(req));
  const sp = new URL(req.url).searchParams;
  const rows = await listProblems({
    publishedOnly: !staff,
    year: sp.get("year") ? Number(sp.get("year")) : undefined,
    contestType: sp.get("contest") || undefined,
    region: sp.get("region") || undefined,
    tech: sp.get("tech") || undefined,
    keyword: sp.get("q") || undefined,
  });
  // 分面数据供前端渲染筛选器；staff 可见未发布题目
  const facets = sp.get("facets") === "1" ? await problemFacets(!staff) : undefined;
  // 顶层暴露：列表为空时前端才能区分「真的没有题目」与「数据库结构落后」
  const taxonomyReady = rows.length ? rows[0].taxonomy_ready !== false : (facets as any)?.taxonomy_ready !== false;
  return NextResponse.json({ problems: rows, staff, facets, taxonomy_ready: taxonomyReady });
}

/** POST：工作人员创建题目。带 PDF 时同一份文件不重复解析。 */
export async function POST(req: NextRequest) {
  const tier = resolveTier(req);
  if (!isStaff(tier)) return NextResponse.json({ error: "仅工作人员可创建官方题目" }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  if (!b.year || !b.code || !b.title) {
    return NextResponse.json({ error: "需要 { year, code, title }" }, { status: 400 });
  }

  if (b.data_base64) {
    const sha = pdfSha256(b.data_base64);
    const existing = await findVersionByPdf(sha);
    if (existing) {
      return NextResponse.json({
        problem_id: (existing as any).problem_id, version_id: (existing as any).version_id,
        existing: true, message: "同一份 PDF 已解析过，直接复用已有版本",
      });
    }
  }

  const problemId = await createProblem({
    year: Number(b.year), code: b.code, title: b.title, groupName: b.group_name, createdBy: tier,
  });
  const versionId = await createDraftVersion(problemId, {
    rawText: b.raw_text,
    pdfSha: b.data_base64 ? pdfSha256(b.data_base64) : undefined,
  });
  return NextResponse.json({ problem_id: problemId, version_id: versionId }, { status: 201 });
}
