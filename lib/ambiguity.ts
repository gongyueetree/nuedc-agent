/** 题面歧义的决策闭环。
 *
 *  学生测试报告（2026-07-28）指出：系统能识别歧义（如"相位差是单路相位
 *  还是两路相位差""RMS 误差要求未给出"），但只有文本提示，没有任何决策
 *  入口，而且三项歧义全部悬空时仍允许生成方案。
 *
 *  设计要点：
 *  - 每项歧义必须做出决策后才能采用主方案（探索性草案不受限）
 *  - "保持开放"是合法决策，但方案必须按保守假设处理并在报告中声明
 *  - 所有决策写入报告的「题意分析与设计假设」章节，让评委看到判断依据
 */

export const DECISION_KINDS = ["adopt_option", "custom", "keep_open", "ask_advisor"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export const DECISION_LABEL: Record<DecisionKind, string> = {
  adopt_option: "采用某种解释",
  custom: "自定义解释",
  keep_open: "保持开放（按保守假设设计）",
  ask_advisor: "需询问指导教师",
};

/** 歧义严重度。critical 会阻止采用主方案。 */
export type AmbiguitySeverity = "critical" | "normal";

export interface AmbiguityOption {
  key: string;          // "A" / "B" / "C"
  text: string;         // 该解释的含义
  implication?: string; // 采纳后对设计的影响
}

export interface AmbiguityDecision {
  kind: DecisionKind;
  /** adopt_option 时指向 options 里的 key */
  optionKey?: string | null;
  /** custom / keep_open / ask_advisor 时的说明文字 */
  note?: string | null;
}

export interface Ambiguity {
  note_id: string;
  content: string;
  severity: AmbiguitySeverity;
  options: AmbiguityOption[];
  resolved: boolean;
  decision: AmbiguityDecision | null;
  decided_by?: string | null;
  decided_at?: string | null;
}

export function parseOptions(raw: unknown): AmbiguityOption[] {
  if (Array.isArray(raw)) {
    return raw
      .map((o: any, i: number) => ({
        key: String(o?.key || String.fromCharCode(65 + i)),
        text: String(o?.text || o || "").trim(),
        implication: o?.implication ? String(o.implication) : undefined,
      }))
      .filter((o) => o.text);
  }
  if (typeof raw === "string" && raw.trim()) {
    try { return parseOptions(JSON.parse(raw)); } catch { /* 非 JSON */ }
  }
  return [];
}

export function parseDecision(raw: unknown): AmbiguityDecision | null {
  if (!raw) return null;
  let d: any = raw;
  if (typeof raw === "string") {
    try { d = JSON.parse(raw); } catch { return { kind: "custom", note: raw }; }
  }
  const kind = DECISION_KINDS.includes(d?.kind) ? d.kind as DecisionKind : null;
  if (!kind) return null;
  return {
    kind,
    optionKey: d.optionKey ?? d.option_key ?? null,
    note: d.note ?? null,
  };
}

/** 校验一项决策是否完整。返回 null 表示合法。 */
export function validateDecision(d: AmbiguityDecision, options: AmbiguityOption[]): string | null {
  if (!DECISION_KINDS.includes(d.kind)) return "未知的决策类型";
  if (d.kind === "adopt_option") {
    if (!d.optionKey) return "需要指定采用哪一种解释";
    if (options.length && !options.some((o) => o.key === d.optionKey)) {
      return `解释「${d.optionKey}」不在候选项中`;
    }
  }
  if (d.kind === "custom" && !String(d.note || "").trim()) {
    return "自定义解释需要填写具体内容";
  }
  if (d.kind === "keep_open" && !String(d.note || "").trim()) {
    // 保持开放必须说明保守假设，否则方案无从下手
    return "保持开放时需说明按什么保守假设设计（例如取两种解释中更严格的一方）";
  }
  return null;
}

/** 采用主方案的门槛：critical 歧义必须全部有决策。
 *  探索性草案不受此限 —— 学生需要先看到方案雏形才好判断歧义。 */
export function canAdoptSolution(list: Ambiguity[]): {
  ok: boolean; blocking: Ambiguity[]; pendingNormal: number;
} {
  const blocking = list.filter((a) => a.severity === "critical" && !a.resolved);
  const pendingNormal = list.filter((a) => a.severity !== "critical" && !a.resolved).length;
  return { ok: blocking.length === 0, blocking, pendingNormal };
}

/** 生成报告用的「题意分析与设计假设」段落。
 *  评委看的是判断依据，因此要把原始歧义、所采解释、影响一并写出。 */
export function renderDesignAssumptions(list: Ambiguity[]): string {
  const decided = list.filter((a) => a.resolved && a.decision);
  if (!decided.length) return "";

  const lines: string[] = ["### 题意分析与设计假设", ""];
  lines.push("题面中存在以下需要判断的表述，本方案的处理如下：", "");

  decided.forEach((a, i) => {
    const d = a.decision!;
    lines.push(`**${i + 1}. ${a.content}**`);
    if (d.kind === "adopt_option") {
      const opt = a.options.find((o) => o.key === d.optionKey);
      lines.push(`- 采用解释：${opt ? opt.text : d.optionKey}`);
      if (opt?.implication) lines.push(`- 对设计的影响：${opt.implication}`);
    } else if (d.kind === "custom") {
      lines.push(`- 按以下理解设计：${d.note}`);
    } else if (d.kind === "keep_open") {
      lines.push(`- 保持开放，按保守假设设计：${d.note}`);
      lines.push("- 说明：题面未明确，本方案按更严格的一方实现，以覆盖两种可能");
    } else if (d.kind === "ask_advisor") {
      lines.push(`- 已向指导教师确认：${d.note || "（待记录确认结果）"}`);
    }
    lines.push("");
  });

  const open = list.filter((a) => !a.resolved);
  if (open.length) {
    lines.push(`> 另有 ${open.length} 项题面表述尚未判断，相关指标以题面原文为准。`, "");
  }
  return lines.join("\n");
}

/** 供 Agent 使用的歧义上下文。保持开放的项要让模型知道按保守假设处理。 */
export function ambiguityContextForAgent(list: Ambiguity[]): string {
  if (!list.length) return "";
  const lines: string[] = ["【题面歧义与已定决策】"];
  for (const a of list) {
    if (!a.resolved || !a.decision) {
      lines.push(`- 未决：${a.content}（按题面原文最严格的理解处理，并在方案说明中标注）`);
      continue;
    }
    const d = a.decision;
    if (d.kind === "adopt_option") {
      const opt = a.options.find((o) => o.key === d.optionKey);
      lines.push(`- 已定：${a.content} → 按「${opt?.text || d.optionKey}」设计`);
    } else if (d.kind === "custom") {
      lines.push(`- 已定：${a.content} → ${d.note}`);
    } else if (d.kind === "keep_open") {
      lines.push(`- 保持开放：${a.content} → 按保守假设「${d.note}」设计，必要时给出兼容两种情况的方案`);
    } else {
      lines.push(`- 待确认：${a.content} → ${d.note || "等待指导教师答复"}，暂按保守假设处理`);
    }
  }
  return lines.join("\n");
}
