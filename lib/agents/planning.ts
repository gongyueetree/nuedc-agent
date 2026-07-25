// 规划类 Agent：赛题理解、题目预测、模块知识库检索推荐
import { llmJson } from "../llm";
import { registerAgent, loadModuleIndex, currentAgentContext } from "./base";
import { buildModuleContext, extractTags } from "../module-search";
import { scoreDirection, type DirectionScoreInput } from "../rules/forecast-scoring";
import type { Requirement } from "../types";

// ============ Agent 2：赛题与需求理解（Problem Interpreter）============
registerAgent("problem_interpreter", async (input) => {
  const problemText: string = input.problem_text || "";
  if (!problemText.trim()) return { ok: false, output: null, message: "缺少赛题文本 problem_text" };

  const out = await llmJson<{
    title: string;
    requirements: Requirement[];
    scoring_items: { item: string; points: number | null; points_type: "official" | "estimated"; requirement_ids: string[]; source: string }[];
    system_inputs: string[];
    system_outputs: string[];
    ambiguities: string[];
  }>({
    system: `你是全国大学生电子设计竞赛（NUEDC）的赛题分析专家。把赛题原文转换成结构化工程需求。
规则：
1. 区分"基本要求"（priority=mandatory）与"发挥部分"（priority=bonus）
2. 提取所有量化指标：尺寸、重量、电压、时间、精度、误差，写入 target 和 unit；允许误差写入 tolerance（如"±1%"）
3. 每条需求编号 REQ-001 起，type ∈ functional|performance|constraint|bonus
4. verification_method ∈ measurement|demonstration|inspection|analysis
5. 逐条标注 source：必须引用赛题原文对应表述（可截取关键句，不要改写）；若题面带【第N页】标记，把页码写入 source_page 字段
5b. 每条需求 status 字段：确定无歧义的填 "AI_EXTRACTED"，题面表述含糊的填 "AMBIGUOUS"
6. 不确定或有歧义的地方放入 ambiguities，不要擅自补全
7. 识别系统输入（被测/被控对象、传感来源）与输出（执行、显示、通信）
8. scoring_items 只能来自题面评分表：题面明确写出分值的填 points 且 points_type="official"；
   题面有评分项但未写分值的 points=null 且 points_type="estimated"；禁止编造分值。
   每个评分项用 requirement_ids 关联到对应的 REQ 编号`,
    messages: [{ role: "user", content: `赛题原文：\n\n${problemText}` }],
    maxTokens: 8192,
  });

  return {
    ok: true,
    artifact_type: "requirements",
    output: out,
    human_review_required: (out.ambiguities || []).length > 0,
    message: `解析出 ${out.requirements?.length ?? 0} 条需求${out.ambiguities?.length ? `，${out.ambiguities.length} 处歧义需人工确认` : ""}`,
  };
});

// ============ Agent 3：题目预测（Topic Forecast）============
// 规则评分排序 + LLM 生成解释与备赛建议；输出分档不输出虚假精确概率
registerAgent("topic_forecast", async (input) => {
  const directions: DirectionScoreInput[] = input.directions?.length
    ? input.directions
    : DEFAULT_DIRECTIONS(input.device_list || []);

  const scored = directions.map(scoreDirection).sort((a, b) => b.score - a.score);

  let commentary: any = null;
  try {
    commentary = await llmJson<{ analysis: string; preparation: { direction: string; actions: string[] }[] }>({
      system: `你是电赛备赛教练。基于给定的规则评分结果（不是统计概率），为排名前列的方向给出备赛建议：应准备的模块、代码模板、需要提前验证的技术点。只解释，不修改分数。`,
      messages: [
        {
          role: "user",
          content: `本年度器件清单：${JSON.stringify(input.device_list || [])}\n规则评分结果：${JSON.stringify(scored)}`,
        },
      ],
      maxTokens: 2048,
    });
  } catch { /* LLM 不可用时仍返回规则评分 */ }

  return {
    ok: true,
    artifact_type: "forecast",
    output: {
      predictions: scored,
      commentary,
      disclaimer: "预测仅用于备赛资源分配，分数用于排序，不代表统计意义上的真实概率。",
    },
  };
});

function DEFAULT_DIRECTIONS(deviceList: string[]): DirectionScoreInput[] {
  const has = (kw: RegExp) => deviceList.filter((d) => kw.test(d));
  return [
    { direction: "视觉智能车", years_since_last: 2, device_list_hits: has(/摄像|camera|k230|openmv|小车|电机/i), new_device_hits: has(/k230/i), vendor_push_weight: 7, testability_weight: 8, appeared_last_year: false },
    { direction: "数字电源", years_since_last: 3, device_list_hits: has(/dc.?dc|buck|boost|电源|mos/i), new_device_hits: [], vendor_push_weight: 8, testability_weight: 9, appeared_last_year: false },
    { direction: "信号源/测量仪器", years_since_last: 1, device_list_hits: has(/dds|dac|adc|运放|ad9/i), new_device_hits: has(/dds/i), vendor_push_weight: 6, testability_weight: 9, appeared_last_year: true },
    { direction: "无人机/飞行器", years_since_last: 2, device_list_hits: has(/imu|mpu|电调|无刷|飞控/i), new_device_hits: [], vendor_push_weight: 5, testability_weight: 5, appeared_last_year: false },
    { direction: "无线通信/图传", years_since_last: 3, device_list_hits: has(/无线|wifi|lora|2\.4g|图传/i), new_device_hits: [], vendor_push_weight: 5, testability_weight: 6, appeared_last_year: false },
    { direction: "FPGA 高速信号处理", years_since_last: 4, device_list_hits: has(/fpga|高速adc/i), new_device_hits: [], vendor_push_weight: 4, testability_weight: 7, appeared_last_year: false },
  ];
}

// ============ Agent 7：模块知识库（Module Knowledge）============
// DB 检索 + LLM 推荐。推荐结果必须含理由/未满足指标/风险/替代模块。
// 推荐时优先证据等级高（E5/E6 实测）的模块参数
registerAgent("module_knowledge", async (input) => {
  // 可见范围取自 ALS 上下文（并发安全），不从 input 读 —— input 可伪造
  const actx = currentAgentContext();
  const index = await loadModuleIndex(400, { viewerRef: actx.owner, orgRef: actx.org });
  const modCtx = buildModuleContext(Object.values(index), {
    viewerRef: actx.owner, orgRef: actx.org,
    requirementTags: extractTags(input.requirements?.requirements || []),
    topK: 25,
  });
  const catalog = modCtx.text;
  const query: string = input.query || input.objective || "";
  const requirements = input.requirements || [];

  const out = await llmJson<{
    recommendations: {
      module_id: string;
      reason: string;
      satisfies_requirements: string[];
      unmet_specs: string[];
      risks: string[];
      alternatives: string[];
    }[];
    missing_capabilities: string[];
  }>({
    system: `你是电赛模块选型专家。模块参数附有证据等级（E0 AI推断…E5/E6 实验室实测）时，推荐理由必须优先引用高证据等级的参数，并对仅有 E0~E2 证据的关键参数明确提示"需实测确认"。只能从下面的模块目录中推荐，禁止虚构模块 id。
每条推荐必须给出：推荐理由、满足哪些需求（引用 REQ id）、尚未满足的指标、风险、可替代模块 id。
目录中没有的能力放入 missing_capabilities，如实说明。
模块目录：
${catalog || "（模块库为空）"}
【模块选用硬规则】目录中标注【本组织】或【我的】的模块，在功能等价时必须优先选用；
若最终选了公共模块，必须在该功能块的 reason / notes 中说明为什么本组织模块不适用
（如电压不匹配、接口缺失、电流不足），不得无理由跳过。`,
    messages: [
      {
        role: "user",
        content: `需求：${query}\n结构化需求（如有）：${JSON.stringify(requirements).slice(0, 6000)}`,
      },
    ],
    maxTokens: 3072,
  });

  // 校验推荐的 id 真实存在（防幻觉）
  const valid = (out.recommendations || []).filter((r) => index[r.module_id]);
  const dropped = (out.recommendations || []).length - valid.length;

  return {
    ok: true,
    artifact_type: "module_recommendation",
    output: {
      ...out,
      recommendations: valid.map((r) => ({ ...r, module: summarize(index[r.module_id]) })),
    },
    message: dropped > 0 ? `已丢弃 ${dropped} 条虚构模块推荐` : undefined,
  };
});

function summarize(m: any) {
  return {
    id: m.id, name: m.name, category: m.category, main_chip: m.main_chip,
    certification_status: m.certification_status, price: m.price,
    interfaces: m.interfaces, power: m.power, known_issues: m.known_issues,
  };
}
