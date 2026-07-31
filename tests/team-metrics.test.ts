import { describe, it, expect } from "vitest";
import { generateTeamCode, normalizeTeamCode, teamRefOf, makeTeamToken, verifyTeamToken } from "../lib/team";
import { inferMetricKind, judgeRecord, METRIC_SPECS } from "../lib/test-metrics";

/** 学生测试报告 P0-4：项目未按用户隔离；P1-2：测试评分对所有指标用同一录入方式 */

describe("P0-4 队伍隔离", () => {
  it("队伍码去除易混淆字符", () => {
    for (let i = 0; i < 20; i++) {
      const c = generateTeamCode();
      expect(c).toHaveLength(6);
      expect(c).not.toMatch(/[0O1I]/);
    }
  });

  it("队伍码规范化：大小写、空格、连字符", () => {
    expect(normalizeTeamCode(" ab-cd ef ")).toBe("ABCDEF");
    expect(normalizeTeamCode("abc")).toBeNull();          // 太短
    expect(normalizeTeamCode("中文码")).toBeNull();
  });

  it("同一队伍码得到相同 teamRef，不同码互不相同", () => {
    expect(teamRefOf("ABCDEF")).toBe(teamRefOf("ABCDEF"));
    expect(teamRefOf("ABCDEF")).not.toBe(teamRefOf("GHJKLM"));
    // 不存明文码
    expect(teamRefOf("ABCDEF")).not.toContain("ABCDEF");
  });

  it("令牌可往返，篡改后失效", () => {
    const t = makeTeamToken("ABCDEF", "小张");
    const s = verifyTeamToken(t);
    expect(s?.code).toBe("ABCDEF");
    expect(s?.member).toBe("小张");
    expect(verifyTeamToken(t.slice(0, -3) + "xxx")).toBeNull();
    expect(verifyTeamToken(undefined)).toBeNull();
  });

  it("项目列表按队伍过滤，未加入时只看本设备", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/projects/route.ts", "utf8");
    expect(src).toContain("verifyTeamToken");
    expect(src).toContain("team_ref=?");
    // 未加入队伍的人不该看到队伍项目
    expect(src).toContain("team_ref IS NULL");
  });

  it("创建项目时记录队伍与创建人", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/projects/route.ts", "utf8");
    expect(src).toContain("team_ref, created_by_name");
  });
});

describe("P1-2 测试指标分类", () => {
  it("按需求内容推断指标类型", () => {
    expect(inferMetricKind({ description: "输出线电压 32V", target: "32", unit: "V" })).toBe("single_point");
    expect(inferMetricKind({ description: "频率测量范围", target: "1Hz~1MHz" })).toBe("range");
    expect(inferMetricKind({ description: "具备过流保护功能" })).toBe("safety");
    expect(inferMetricKind({ description: "启动响应时间不大于 5s", target: "5" })).toBe("timing");
    expect(inferMetricKind({ description: "自动量程切换" })).toBe("functional");
    expect(inferMetricKind({ description: "传输距离 10m", target: "10", type: "advanced" })).toBe("bonus");
  });

  it("单点指标按容差判定，支持百分比", () => {
    expect(judgeRecord("single_point", { target: "32", tolerance: "±0.25V" }, { measured: "32.1" }).pass).toBe(true);
    expect(judgeRecord("single_point", { target: "32", tolerance: "±0.25V" }, { measured: "33" }).pass).toBe(false);
    expect(judgeRecord("single_point", { target: "100", tolerance: "≤1%" }, { measured: "100.5" }).pass).toBe(true);
  });

  it("时序类按上限判定", () => {
    expect(judgeRecord("timing", { target: "5" }, { measured: "4.2" }).pass).toBe(true);
    expect(judgeRecord("timing", { target: "5" }, { measured: "6" }).pass).toBe(false);
  });

  it("功能项判通过必须有验证记录", () => {
    expect(judgeRecord("functional", {}, { verdict: true }).pass).toBeNull();
    expect(judgeRecord("functional", {}, { verdict: true, evidence: "按下按钮蜂鸣器响" }).pass).toBe(true);
  });

  it("范围类只测端点不能判通过 —— 这是常见失分点", () => {
    const r = judgeRecord("range", { tolerance: "±1%" }, { min_measured: "1", max_measured: "1000000" });
    expect(r.pass).toBeNull();
    expect(r.reason).toContain("仅测端点");
  });

  it("缺少数据时返回待判定而非硬判", () => {
    expect(judgeRecord("single_point", { target: "32" }, {}).pass).toBeNull();
    expect(judgeRecord("single_point", { target: "32" }, { measured: "32" }).pass).toBeNull();
  });

  it("每种类型都有录入项、判据与提示", () => {
    for (const [kind, spec] of Object.entries(METRIC_SPECS)) {
      expect(spec.inputs.length, `${kind} 无录入项`).toBeGreaterThan(0);
      expect(spec.judge, `${kind} 无判据`).toBeTruthy();
    }
  });

  it("评分页按类型渲染不同录入项", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/pages-work.tsx", "utf8");
    expect(src).toContain("inferMetricKind");
    expect(src).toContain("METRIC_SPECS");
    expect(src).toContain("自动判定");
    expect(src).toContain("人工覆盖");
  });
});
