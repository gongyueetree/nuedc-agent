import { describe, it, expect } from "vitest";
import { suggestTechTags, parseTags, TECH_CATEGORIES, CONTEST_TYPES } from "../lib/problem-taxonomy";

describe("赛题技术分类", () => {
  it("按题目名称推断技术方向", () => {
    expect(suggestTechTags("数字控制 DC-DC 变换器")).toContain("power");
    expect(suggestTechTags("无线传输信号模拟系统")).toContain("rf");
    expect(suggestTechTags("自动跟踪四旋翼无人机")).toContain("mechatronic");
    expect(suggestTechTags("高精度电压测量装置")).toContain("instrument");
    expect(suggestTechTags("AD9833 信号发生器")).toContain("signal_source");
  });

  it("一道题可归多个方向，最多三个", () => {
    const tags = suggestTechTags("数字控制无线充电电源，含 PID 调节与频谱分析");
    expect(tags.length).toBeGreaterThan(1);
    expect(tags.length).toBeLessThanOrEqual(3);
  });

  it("题面里的通用词不得污染分类（视觉测量题不该标成电源类）", () => {
    // 真实案例：2025 C 题题面提到 4 次「电源」（供电条件），
    // 但它是视觉测量题。标题命中时只采信标题。
    const body = "测量电路和单目摄像头组成测量系统，由 5V 电源供电，电源纹波不大于 50mV，"
      + "电源效率要求…充电指示灯…".repeat(3);
    const tags = suggestTechTags("基于单目视觉的目标物测量装置", body);
    expect(tags).toContain("instrument");
    expect(tags, "题面的供电描述不应带出电源类").not.toContain("power");
  });

  it("标题明确的电源题仍能正确识别", () => {
    expect(suggestTechTags("AC-AC变换电路并联运行")).toContain("power");
    expect(suggestTechTags("单相交流电子负载")).toContain("power");
    expect(suggestTechTags("能量回馈的变流器负载试验装置")).toContain("power");
  });

  it("机电类题目识别（飞行器/电动车/小车）", () => {
    expect(suggestTechTags("绕障飞行器")).toContain("mechatronic");
    expect(suggestTechTags("具有自动泊车功能的电动车")).toContain("mechatronic");
    expect(suggestTechTags("智能送药小车")).toContain("mechatronic");
  });

  it("无法识别时返回空数组，不硬猜", () => {
    expect(suggestTechTags("某某装置")).toEqual([]);
  });

  it("parseTags 兼容 JSON 字符串、数组与逗号分隔", () => {
    expect(parseTags('["power","control"]')).toEqual(["power", "control"]);
    expect(parseTags(["rf"])).toEqual(["rf"]);
    expect(parseTags("power,instrument")).toEqual(["power", "instrument"]);
    expect(parseTags("不存在的分类")).toEqual([]);       // 过滤非法值
    expect(parseTags(null)).toEqual([]);
  });

  it("分类体系覆盖电赛传统方向", () => {
    for (const c of ["power", "signal_source", "rf", "amplifier", "instrument",
      "data_acquisition", "control", "mechatronic"]) {
      expect(TECH_CATEGORIES as readonly string[]).toContain(c);
    }
    expect(CONTEST_TYPES as readonly string[]).toContain("national");
    expect(CONTEST_TYPES as readonly string[]).toContain("provincial");
  });
});

describe("赛题检索", () => {
  it("listProblems 支持赛事/年份/方向/关键词四个维度", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/problem-center.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function listProblems"));
    for (const dim of ["contestType", "region", "tech", "keyword"]) {
      expect(fn, `缺少检索维度 ${dim}`).toContain(dim);
    }
    // 技术方向存 JSON 数组，用 LIKE 精确匹配带引号的值避免误匹配
    expect(fn).toContain('`%"${opts.tech}"%`');
  });

  it("提供分面统计供筛选器渲染", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/problem-center.ts", "utf8");
    expect(src).toContain("export async function problemFacets");
    expect(src).toContain("contestTypes");
  });

  it("导入工具不抓取第三方网站", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/import-problems.mts", "utf8");
    expect(src).toContain("本工具不抓取第三方网站");
    expect(src).toContain("著作权归竞赛组委会所有");
    // 不得包含针对具体站点的抓取逻辑
    expect(src).not.toMatch(/eetree|fetch\(["'`]https?:\/\//);
  });

  it("导入支持清单与 PDF 目录两种来源，且按 PDF 哈希去重", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/import-problems.mts", "utf8");
    expect(src).toContain('cmd === "manifest"');
    expect(src).toContain('cmd === "pdfdir"');
    expect(src).toContain("findVersionByPdf");
  });
});

describe("旧 schema 兼容（迁移 21 未执行）", () => {
  it("listProblems 缺分类列时降级查询，不返回空列表", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/problem-center.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function listProblems"), src.indexOf("/** 检索维度的可选值与计数"));
    expect(fn).toContain("PG_UNDEFINED_COLUMN");
    expect(fn).toContain("TAXONOMY_FALLBACK");
    expect(fn).toContain("taxonomy_ready");
    // 缺列时把分类过滤条件一并去掉，否则降级查询仍会引用不存在的列
    expect(fn).toContain("build(TAXONOMY_FALLBACK, [], [])");
  });

  it("分类过滤条件与基础条件分离，降级时可单独剔除", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/problem-center.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function listProblems"), src.indexOf("/** 检索维度的可选值与计数"));
    expect(fn).toContain("taxonomyWhere");
    expect(fn).toContain("taxonomyArgs");
  });

  it("problemFacets 缺列时返回空分面而非抛错", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/problem-center.ts", "utf8");
    expect(src).toContain("problemFacetsInner");
    expect(src).toContain("taxonomy_ready: false");
  });

  it("API 顶层返回 taxonomy_ready，空列表时前端可区分原因", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/problems/route.ts", "utf8");
    expect(src).toContain("taxonomy_ready: taxonomyReady");
    expect(src).toContain("真的没有题目");
  });

  it("前端在结构落后时提示执行迁移，而非「还没有题目」", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/ProblemCenterClient.tsx", "utf8");
    expect(src).toContain("taxonomyReady");
    expect(src).toContain("数据库结构落后于当前版本");
    expect(src).toContain("npm run db:init");
  });
});
