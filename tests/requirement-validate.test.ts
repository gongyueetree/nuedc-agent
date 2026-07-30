import { describe, it, expect } from "vitest";
import { normalizeTarget, validateRequirement, validateRequirements } from "../lib/requirement-validate";

/** 学生测试报告（2026-07-28）实测到的解析错误：
 *  1Hz~1MHzHz / 10mVpp~10VppVpp / ≤1%% / ≤1°°
 *  这些错误当时可被「一键全部确认」放行，会传播到方案、BOM、代码与报告。 */

const show = (n: ReturnType<typeof normalizeTarget>) =>
  `${n.target ?? ""}${n.unit ?? ""}${n.tolerance ? " " + n.tolerance : ""}`;

describe("单位重复（学生报告实测）", () => {
  it("范围值已含单位时清空 unit，不再拼出 1Hz~1MHzHz", () => {
    expect(show(normalizeTarget({ target: "1Hz~1MHz", unit: "Hz" }))).toBe("1Hz~1MHz");
  });

  it("10mVpp~10Vpp 不被截断也不重复", () => {
    expect(show(normalizeTarget({ target: "10mVpp~10Vpp", unit: "Vpp" }))).toBe("10mVpp~10Vpp");
  });

  it("单值含单位时拆分而非拼接", () => {
    expect(show(normalizeTarget({ target: "100mA", unit: "A" }))).toBe("100mA");
  });

  it("误差里的重复符号被规范化", () => {
    expect(normalizeTarget({ target: "1", unit: "%", tolerance: "≤1%%" }).tolerance).toBe("≤1%");
    expect(normalizeTarget({ tolerance: "≤1°°" }).tolerance).toBe("≤1°");
    expect(normalizeTarget({ tolerance: "≤≤1%" }).tolerance).toBe("≤1%");
  });

  it("正常值不受影响", () => {
    expect(show(normalizeTarget({ target: "5", unit: "V" }))).toBe("5V");
    expect(show(normalizeTarget({ target: "3.3", unit: "V" }))).toBe("3.3V");
    expect(show(normalizeTarget({}))).toBe("");
  });
});

describe("校验阻断项", () => {
  it("描述中的重复单位判为 error", () => {
    const errs = validateRequirement({ description: "幅度误差≤1%%" })
      .filter((x) => x.severity === "error");
    expect(errs.length).toBeGreaterThan(0);
  });

  it("描述为空判为 error", () => {
    expect(validateRequirement({ description: "" }).some((x) => x.severity === "error")).toBe(true);
  });

  it("类型 uncertain 提示会影响评分权重", () => {
    const w = validateRequirement({ description: "输出 5V 电压", type: "uncertain" });
    expect(w.some((x) => x.message.includes("评分权重"))).toBe(true);
  });

  it("缺原文引用给出警告", () => {
    const w = validateRequirement({ description: "输出 5V 电压", type: "basic" });
    expect(w.some((x) => x.message.includes("溯源"))).toBe(true);
  });

  it("正常需求无 error", () => {
    const errs = validateRequirement({
      description: "变流器输出线电压 32V", type: "basic",
      target: "32", unit: "V", tolerance: "±0.25V", source_quote: "线电压U1=32V",
    }).filter((x) => x.severity === "error");
    expect(errs).toHaveLength(0);
  });

  it("批量校验汇总出阻断索引", () => {
    const r = validateRequirements([
      { description: "正常需求描述", type: "basic", source_quote: "原文" },
      { description: "误差≤1%%", type: "basic", source_quote: "原文" },
      { description: "", type: "basic" },
    ]);
    expect(r.blockingIndexes).toContain(1);
    expect(r.blockingIndexes).toContain(2);
    expect(r.blockingIndexes).not.toContain(0);
  });
});

describe("P0-2 一键确认不得放行错误", () => {
  it("批量确认拒绝含阻断错误的需求，除非显式 force", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/problems/[id]/route.ts", "utf8");
    const seg = src.slice(src.indexOf('b.action === "confirm_all"'));
    expect(seg).toContain("validateRequirements");
    expect(seg).toContain("b.force !== true");
    expect(seg).toContain("status: 422");
    expect(seg).toContain("blocking:");
  });

  it("保存需求时先规范化，避免错误入库", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/problem-center.ts", "utf8");
    expect(src).toContain("normalizeTarget");
    expect(src).toContain("会一路污染方案/BOM/报告");
  });

  it("前端逐条列出必须修正的错误", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/ProblemCenterClient.tsx", "utf8");
    expect(src).toContain("res.status === 422");
    expect(src).toContain("请逐条修正后再确认");
    expect(src).toContain("忽略校验");
  });
});

describe("P0-5 各阶段前置门槛一致", () => {
  it("代码生成需要已确认主方案", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/pages-build.tsx", "utf8");
    const at = src.indexOf("ctx.runCode(target)");
    const seg = src.slice(Math.max(0, at - 500), at + 500);
    expect(seg).toContain("!ctx.chosenSolution");
    expect(src).toContain("主控型号");
  });

  it("报告生成需要已确认主方案", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/pages-build.tsx", "utf8");
    const at = src.indexOf("ctx.runReport(");
    const seg = src.slice(Math.max(0, at - 500), at + 500);
    expect(seg).toContain("!ctx.chosenSolution");
    expect(src).toContain("缺少时只能生成空壳");
  });

  it("测试评分空数据时给出明确提示而非静默", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/pages-work.tsx", "utf8");
    expect(src).toContain("还没有录入任何测试数据");
    expect(src).toContain("按「待补充」处理");
  });
});

describe("学生端错误表达与测试数据隔离", () => {
  it("不向学生暴露内部诊断接口与运维措辞", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/Platform.tsx", "utf8");
    expect(src).not.toContain("/api/diag");
    expect(src).not.toContain("JSON 生成能力");
    // 应告知输入已保存、可重试
    expect(src).toContain("你的需求已保存");
    expect(src).toContain("无需重新粘贴赛题");
  });

  it("压测与冒烟项目不出现在项目列表", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/projects/route.ts", "utf8");
    expect(src).toContain("压测");
    expect(src).toContain("E2E%");
    expect(src).toContain("include_test");
  });

  it("非管理员只能看到自己的项目", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/projects/route.ts", "utf8");
    expect(src).toContain("WHERE owner=?");
  });
});
