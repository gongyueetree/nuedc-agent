import { describe, it, expect } from "vitest";
import {
  validateDecision, canAdoptSolution, renderDesignAssumptions,
  ambiguityContextForAgent, parseOptions, parseDecision, type Ambiguity,
} from "../lib/ambiguity";

/** 学生测试报告 P0-3：系统能识别题面歧义，但只有文本提示、
 *  没有任何决策入口，且三项歧义全部悬空时仍允许生成方案。 */

const opts = parseOptions([
  { key: "A", text: "单路信号的相位", implication: "只需一个通道" },
  { key: "B", text: "两路信号的相位差", implication: "需双通道同步采样" },
]);

const mk = (over: Partial<Ambiguity>): Ambiguity => ({
  note_id: "n1", content: "相位差是单路还是两路", severity: "critical",
  options: opts, resolved: false, decision: null, ...over,
});

describe("决策校验", () => {
  it("采用某项解释必须指定且存在", () => {
    expect(validateDecision({ kind: "adopt_option", optionKey: "A" }, opts)).toBeNull();
    expect(validateDecision({ kind: "adopt_option" }, opts)).toContain("指定");
    expect(validateDecision({ kind: "adopt_option", optionKey: "Z" }, opts)).toContain("不在候选项");
  });

  it("自定义解释必须填内容", () => {
    expect(validateDecision({ kind: "custom", note: "" }, opts)).toContain("填写");
    expect(validateDecision({ kind: "custom", note: "按两路实现" }, opts)).toBeNull();
  });

  it("保持开放必须说明保守假设 —— 否则方案无从下手", () => {
    expect(validateDecision({ kind: "keep_open" }, opts)).toContain("保守假设");
    expect(validateDecision({ kind: "keep_open", note: "取更严格的一方" }, opts)).toBeNull();
  });

  it("parseDecision 兼容旧的纯文本 resolution", () => {
    expect(parseDecision("已确认")?.kind).toBe("custom");
    expect(parseDecision(null)).toBeNull();
  });
});

describe("采用主方案的门槛", () => {
  it("关键歧义未决时不可采用", () => {
    const g = canAdoptSolution([mk({})]);
    expect(g.ok).toBe(false);
    expect(g.blocking).toHaveLength(1);
  });

  it("一般歧义未决不阻断，但会计数提示", () => {
    const g = canAdoptSolution([mk({ severity: "normal" })]);
    expect(g.ok).toBe(true);
    expect(g.pendingNormal).toBe(1);
  });

  it("关键歧义全部决策后可采用", () => {
    const g = canAdoptSolution([
      mk({ resolved: true, decision: { kind: "adopt_option", optionKey: "B" } }),
    ]);
    expect(g.ok).toBe(true);
  });
});

describe("写入报告的设计假设", () => {
  const list = [
    mk({ resolved: true, decision: { kind: "adopt_option", optionKey: "B" } }),
    mk({ note_id: "n2", content: "RMS 误差未给出", options: [], resolved: true,
      decision: { kind: "keep_open", note: "按 ±1% 保守设计" } }),
    mk({ note_id: "n3", content: "显示方式未说明", severity: "normal", options: [], resolved: false }),
  ];

  it("采用的解释与对设计的影响都写进去", () => {
    const md = renderDesignAssumptions(list);
    expect(md).toContain("题意分析与设计假设");
    expect(md).toContain("两路信号的相位差");
    expect(md).toContain("需双通道同步采样");
  });

  it("保持开放的项声明保守假设，让评委看到依据", () => {
    const md = renderDesignAssumptions(list);
    expect(md).toContain("按 ±1% 保守设计");
    expect(md).toContain("按更严格的一方实现");
  });

  it("未决项单独说明数量，不假装已处理", () => {
    expect(renderDesignAssumptions(list)).toContain("尚未判断");
  });

  it("无决策时不产生空章节", () => {
    expect(renderDesignAssumptions([mk({})])).toBe("");
  });
});

describe("传给 Agent 的约束", () => {
  it("未决歧义要求按最严格理解处理并标注", () => {
    const ctx = ambiguityContextForAgent([mk({})]);
    expect(ctx).toContain("最严格的理解");
    expect(ctx).toContain("标注");
  });

  it("保持开放要求给出兼容两种情况的方案", () => {
    const ctx = ambiguityContextForAgent([
      mk({ resolved: true, decision: { kind: "keep_open", note: "取严格一方" } }),
    ]);
    expect(ctx).toContain("兼容两种情况");
  });
});

describe("端到端接线", () => {
  it("采用题目时校验关键歧义", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/projects/[id]/adopt-problem/route.ts", "utf8");
    expect(src).toContain("canAdoptSolution");
    expect(src).toContain("blocking_ambiguities");
    expect(src).toContain("关键歧义未决");
  });

  it("歧义端点要求具体决策而非简单标记已处理", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/problems/[id]/route.ts", "utf8");
    const seg = src.slice(src.indexOf('b.action === "resolve_note"'));
    expect(seg).toContain("decideAmbiguity");
    expect(seg).toContain("保持开放");
    expect(seg).toContain("status: 422");
  });

  it("提取时要求模型给出候选解释与严重度", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/batch-extract.mts", "utf8");
    expect(src).toContain('"ambiguities"');
    expect(src).toContain("critical|normal");
    expect(src).toContain("两种以上具体解释");
  });

  it("报告章节包含题意分析与设计假设", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/agents/delivery.ts", "utf8");
    expect(src).toContain("题意分析与设计假设");
    expect(src).toContain("不得改写或省略");
  });

  it("前端提供四种决策入口", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/ProblemCenterClient.tsx", "utf8");
    expect(src).toContain("自定义解释");
    expect(src).toContain("保持开放（说明保守假设）");
    expect(src).toContain("需询问指导教师");
    expect(src).toContain("采用 {o.key}");
  });
});
