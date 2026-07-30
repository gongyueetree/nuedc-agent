import { NextRequest, NextResponse } from "next/server";
import { resolveTier } from "@/lib/auth";
import { getDraftVersion, createDraftVersion, getVersionContent, saveExtraction, diffExtractions, saveDiffs, pdfSha256 } from "@/lib/problem-center";
import { modelGateway } from "@/lib/model-gateway";
import { problemInterpretationSchema } from "@/lib/agent-schemas";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 300;

const EXTRACT_PROMPT = `你是电赛赛题结构化专家。把赛题原文拆成可核对的结构化数据。

【需求的粒度 —— 最重要】
requirements 只收录「可以逐条验收」的条目，即测试时能明确判定通过/不通过的。
- 收录：带指标的要求（输出 32V±0.25V）、明确的功能要求（自动量程切换）、
  明确的限制（不得使用商用电源模块）
- 不收录：任务概述与背景（"设计并制作一套…系统"）、图表说明、
  对系统组成的描述性文字、重复表述同一指标的句子
一道电赛题通常有 10~25 条可验收需求。若超过 30 条，说明把描述性文字
也当成了需求，请合并或剔除 —— 条目虚高会让后续核对与评分失去意义。
同一指标在题面多处出现时只保留一条，在 source 里引用最完整的那处。

1. requirements：区分 priority（mandatory=基本要求 / bonus=发挥部分）
2. 量化指标写入 target + unit，允许误差写入 tolerance（如 "±1%" / "≤5cm"）。
   单位只写在 unit 里，target 只放数值或范围 —— 不要写成 target="1MHz" 又 unit="Hz"
3. source 必须引用赛题原文对应表述，不要改写；题面带【第N页】标记时把页码写入 source_page
4. scoring_items 只能来自题面评分表：题面写明分值的 points_type="official" 并填 points；
   题面有评分项但未写分值的 points=null 且 points_type="estimated"；禁止编造分值
5. 每个评分项用 requirement_ids 关联到对应 REQ 编号
6. ambiguities 列出题面未明确的点，并给出两种以上具体解释：
   { content, severity: "critical"|"normal",
     options: [{ key: "A", text: "一种解释", implication: "按此设计的影响" }] }
   涉及指标数值、误差要求、测量对象的标 critical
只输出 JSON。`;

/** 双模复核提取：Provider A 提取 → Provider B 复核 → 程序对比差异 → 待人工确认。
 *  这是唯一允许默认双模型的场景（后台工作人员任务），普通用户请求不走这条路径。 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const tier = resolveTier(req);
  if (tier !== "admin" && tier !== "lab") return NextResponse.json({ error: "仅工作人员可执行提取" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  // 只往草稿版本写；没有草稿就开一个新版本（已发布版本不可改）
  let draft: any = await getDraftVersion(params.id);
  if (!draft) {
    const vid = await createDraftVersion(params.id, {
      rawText: body.raw_text,
      pdfSha: body.data_base64 ? pdfSha256(body.data_base64) : undefined,
    });
    draft = { version_id: vid, version_no: 1, raw_text: body.raw_text };
  }
  const versionId = String(draft.version_id);
  const text: string = body.raw_text || draft.raw_text || "";
  const pdfBase64: string | undefined = body.data_base64;
  if (!text && !pdfBase64) return NextResponse.json({ error: "缺少题面文本或 PDF" }, { status: 400 });

  const schema = z.object({ ...problemInterpretationSchema.shape });
  const dual = body.dual_review !== false;   // 默认双模复核

  // 第一遍：主提取（有 PDF 走多模态，否则纯文本）
  const runA = await modelGateway.run({
    taskType: pdfBase64 ? "PDF_EXTRACT" : "PROBLEM_STRUCTURE",
    system: EXTRACT_PROMPT,
    messages: [{ role: "user", content: text ? `赛题原文：\n${text.slice(0, 30000)}` : "请提取该赛题 PDF 的结构化需求与评分项" }],
    pdfBase64,
    schema,
    owner: `staff:${tier}`,
    problemVersion: `${params.id}:${versionId}`,
    allowCache: true,
  });
  if (!runA.ok || !runA.output) {
    return NextResponse.json({ error: runA.message || "提取失败", degraded: runA.degraded }, { status: 502 });
  }
  const a: any = runA.output;

  // 粒度异常提醒：一道电赛题通常 10~25 条可验收需求。
  // 学生实测出现 51 条 —— 任务概述被当成了需求。
  const reqCount = a.requirements?.length || 0;
  const granularityWarning = reqCount > 30
    ? `提取到 ${reqCount} 条需求，明显多于一道赛题的常见数量（10~25 条）。可能把任务概述或描述性文字也当成了需求，建议逐条核对、合并或剔除后再发布。`
    : reqCount < 3
      ? `只提取到 ${reqCount} 条需求，可能题面不完整或解析失败，请核对原文。`
      : null;

  await saveExtraction(versionId, {
    requirements: a.requirements || [],
    scoringItems: a.scoring_items || [],
    ambiguities: a.ambiguities || [],
    rawText: text || undefined,
  });

  if (!dual) {
    return NextResponse.json({
      ok: true, version_id: versionId, provider_a: runA.provider, dual_review: false,
      requirements: a.requirements?.length || 0, scoring_items: a.scoring_items?.length || 0,
    });
  }

  // 第二遍需要另一家 Provider。只配了一家时，同一模型跑两次并不构成
  // 交叉验证 —— 它会给出高度相似的结果，却让人误以为已被复核。
  // 因此如实告知无法复核，而不是产出一堆"两边都是 gemini"的假差异。
  const otherProvider = pickOther(runA.provider);
  if (!otherProvider) {
    return NextResponse.json({
      ok: true, version_id: versionId, provider_a: runA.provider, dual_review: false,
      requirements: reqCount, scoring_items: a.scoring_items?.length || 0,
      granularity_warning: granularityWarning,
      warning: "当前只配置了一家模型服务，无法进行双模交叉复核。" +
        "结果已保存，请人工逐条核对；如需真正的复核，请配置第二家 Provider" +
        "（如 QWEN_API_KEY / DEEPSEEK_API_KEY，并加入 MODEL_PROVIDER_FALLBACK）。",
    });
  }

  const runB = await modelGateway.run({
    taskType: pdfBase64 ? "PDF_EXTRACT" : "PROBLEM_STRUCTURE",
    system: EXTRACT_PROMPT + "\n注意：这是独立复核，请依据原文自行提取，不要参考他人结果。",
    messages: [{ role: "user", content: text ? `赛题原文：\n${text.slice(0, 30000)}` : "请提取该赛题 PDF 的结构化需求与评分项" }],
    // 复核也要能看到 PDF，否则第二遍无内容可读，会全部判成"未提取到"
    pdfBase64,
    schema,
    owner: `staff:${tier}`,
    providerHint: otherProvider,
    allowCache: false,     // 复核必须真跑，不能命中第一遍的缓存
  });

  if (!runB.ok || !runB.output) {
    return NextResponse.json({
      ok: true, provider_a: runA.provider, dual_review: false,
      warning: `复核未成功（${runB.message}），已保存主提取结果，请人工逐条核对`,
      requirements: a.requirements?.length || 0,
    });
  }

  const b: any = runB.output;
  const diffs = diffExtractions(
    { requirements: a.requirements || [], scoring_items: a.scoring_items || [] },
    { requirements: b.requirements || [], scoring_items: b.scoring_items || [] },
  );
  await saveDiffs(versionId, params.id, diffs, runA.provider, runB.provider);

  return NextResponse.json({
    ok: true, version_id: versionId, dual_review: true,
    provider_a: runA.provider, provider_b: runB.provider,
    requirements: a.requirements?.length || 0,
    scoring_items: a.scoring_items?.length || 0,
    diffs: diffs.length,
    critical_diffs: diffs.filter((d) => d.severity === "critical").length,
  });
}

function pickOther(used: string): string | null {
  const chain = (process.env.MODEL_PROVIDER_FALLBACK || "").split(",").map((s) => s.trim()).filter(Boolean);
  const primary = process.env.MODEL_PROVIDER_PRIMARY || "gemini";
  const all = [primary, ...chain];
  return all.find((p) => p !== used) || null;
}
