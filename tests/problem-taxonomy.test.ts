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

describe("赛题中心登录态判定", () => {
  it("以 API 返回的 staff 标志判定，而非「没报错就算登录」", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/ProblemCenterClient.tsx", "utf8");
    const fn = src.slice(src.indexOf("const load = useCallback"), src.indexOf("useEffect(() => { load()"));
    // API 对非管理员不返回 error，只是过滤掉未发布题目；
    // 据此判定已登录会让界面显示「还没有题目」，掩盖真实原因
    expect(fn).toContain("d.staff !== true");
    expect(fn).toContain("setAuthed(false)");
  });

  it("API 返回 staff 字段供前端判定", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/problems/route.ts", "utf8");
    expect(src).toContain("problems: rows, staff");
  });
});

describe("题目详情与删除", () => {
  it("前端按 API 实际返回的 version 字段读取，而非不存在的 problem", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/ProblemCenterClient.tsx", "utf8");
    // API 返回 { version, requirements, scoringItems, notes, reviews, checklist }
    expect(src).toContain("if (!d?.version)");
    expect(src).toContain("requirements: d.requirements || []");
    expect(src).not.toContain("setSel(d.problem)");
  });

  it("删除拒绝已发布题目，除非显式 force", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/problem-center.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function deleteProblem"));
    expect(fn).toContain("publishedCount > 0 && !opts.force");
    // 已被项目采用的题目同样需要确认
    expect(fn).toContain("usedCount > 0 && !opts.force");
    expect(fn).toContain("失去需求来源");
  });

  it("删除在事务内级联清理所有关联表", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/problem-center.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function deleteProblem"));
    expect(fn).toContain("return withTransaction");
    for (const t of ["problem_requirements", "problem_scoring_items", "problem_notes",
      "problem_reviews", "problem_review_diffs", "problem_versions", "official_problems"]) {
      expect(fn, `未清理 ${t}`).toContain(t);
    }
  });

  it("删除端点要求工作人员权限", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/problems/[id]/route.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function DELETE"));
    expect(fn).toContain("isStaff(resolveTier(req))");
    expect(fn).toContain("status: 403");
    expect(fn).toContain("status: 409");   // 有引用时冲突
  });

  it("前端删除有二次确认，强制删除再确认一次", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/ProblemCenterClient.tsx", "utf8");
    const fn = src.slice(src.indexOf("async function removeProblem"), src.indexOf("async function openProblem"));
    expect((fn.match(/confirm\(/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(fn).toContain("不可恢复");
    expect(fn).toContain("force=1");
  });
});

describe("删除语句与实际表结构一致", () => {
  it("每条 DELETE 引用的列都存在于对应表", async () => {
    const { MIGRATIONS } = await import("../lib/migrations");
    const fs = await import("node:fs");
    const all = (MIGRATIONS as any[]).map((m) => m.sql).join("\n");
    const src = fs.readFileSync("lib/problem-center.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function deleteProblem"));

    const stmts = fn.match(/DELETE FROM (\w+) WHERE (\w+)=\?/g) || [];
    expect(stmts.length).toBeGreaterThanOrEqual(6);
    for (const st of stmts) {
      const m = st.match(/DELETE FROM (\w+) WHERE (\w+)=/)!;
      const [, table, col] = m;
      const tbl = all.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}[^;]*`, "i"));
      expect(tbl, `未找到表 ${table}`).toBeTruthy();
      expect(new RegExp(`\\b${col}\\b`).test(tbl![0]), `${table} 没有列 ${col}`).toBe(true);
    }
  });

  it("RETURNING 使用真实存在的主键列（req_id 而非 id）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/problem-center.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function deleteProblem"));
    expect(fn).toContain("RETURNING req_id");
    expect(fn).not.toMatch(/problem_requirements[^;]*RETURNING id\b/);
  });

  it("差异表按 problem_id 清理，不是 version_id", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/problem-center.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function deleteProblem"));
    expect(fn).toContain("DELETE FROM problem_review_diffs WHERE problem_id=?");
  });
});

describe("未提取时的详情页可用性", () => {
  it("没有结构化需求时显示题面原文与下一步指引", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/ProblemCenterClient.tsx", "utf8");
    expect(src).toContain("尚未提取结构化需求");
    expect(src).toContain("查看题面原文");
    // 页面原本一片空白，既看不到题面也不知道该做什么
    expect(src).toContain("!sel.requirements?.length &&");
  });

  it("提取优先复用已入库题面，不必手工再粘一遍", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/ProblemCenterClient.tsx", "utf8");
    const fn = src.slice(src.indexOf("async function extractFromText"), src.indexOf("async function resolveDiff"));
    expect(fn).toContain("sel.raw_text");
    expect(fn).toContain("使用已入库的题面原文执行提取");
    expect(src).toContain("用已入库题面提取");
  });
});

describe("选题界面不铺开全部题目", () => {
  it("未设置筛选条件时不列出题目按钮", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/pages-build.tsx", "utf8");
    // 245 道题全铺开会把页面撑爆
    expect(src).toContain("hasFilter");
    expect(src).toContain("{!hasFilter ? (");
    expect(src).toContain("请用上方条件筛选");
  });

  it("即使筛选后也限制显示条数", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/pages-build.tsx", "utf8");
    expect(src).toContain("SHOW_LIMIT");
    expect(src).toContain("请继续缩小范围");
  });

  it("移除与新筛选器重复的旧年份/题目下拉框", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/pages-build.tsx", "utf8");
    expect(src).not.toContain("— 选择题目 —");
    expect(src).not.toContain("PROBLEM_YEARS");
    expect(src).not.toContain("PAST_PROBLEMS");
  });
});

describe("题库去重工具", () => {
  it("区分「完全重复」与「同名不同题号」两类", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/dedupe-problems.mts", "utf8");
    // 年份+题号+标题全同 → 确定重复
    expect(src).toContain("`${r.year}|${String(r.code).trim()}|${String(r.title).trim()}`");
    // 同名但题号不同 → 很可能是本科组与高职组的同名题，不能删
    expect(src).toContain("suspicious");
    expect(src).toContain("高职高专组的同名题");
    expect(src).toContain("默认不处理");
  });

  it("同名不同题号需显式开关才处理", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/dedupe-problems.mts", "utf8");
    expect(src).toContain("INCLUDE_SAME_TITLE");
    expect(src).toContain('--include-same-title');
  });

  it("计数字段统一转数字（驱动可能返回字符串）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/dedupe-problems.mts", "utf8");
    const fn = src.slice(src.indexOf("function score"), src.indexOf("async function main"));
    expect(fn).toContain("Number(r.published)");
    expect(fn).toContain("Number(r.requirements)");
  });

  it("保留信息最全的一条：已发布 > 有需求 > 有版本 > 有题面", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/dedupe-problems.mts", "utf8");
    const fn = src.slice(src.indexOf("function score"), src.indexOf("async function main"));
    expect(fn).toContain("Number(r.published) > 0 ? 10000");
    expect(fn).toContain("requirements");
    expect(fn).toContain("has_raw");
  });

  it("默认干跑，需显式 --apply 才删除", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/dedupe-problems.mts", "utf8");
    expect(src).toContain('APPLY = process.argv.includes("--apply")');
    expect(src).toContain("干跑模式，未删除任何内容");
  });
});

describe("赛事类型按年份判定", () => {
  it("奇数年国赛、偶数年省赛", async () => {
    const { contestTypeByYear } = await import("../lib/problem-taxonomy");
    for (const y of [2019, 2021, 2023, 2025]) expect(contestTypeByYear(y)).toBe("national");
    for (const y of [2020, 2022, 2024, 2026]) expect(contestTypeByYear(y)).toBe("provincial");
  });

  it("导入时按年份自动判定，不再一律标国赛", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/import-eetree.mts", "utf8");
    expect(src).toContain("contestTypeByYear(m.year)");
    expect(src).not.toContain('contestType: "national", techTags');
  });

  it("修正脚本只动 official_problems，不碰模块表", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/fix-contest-type.mts", "utf8");
    expect(src).toContain("不触碰 modules 表");
    expect(src).toContain("UPDATE official_problems SET contest_type");
    expect(src).not.toMatch(/UPDATE modules|DELETE FROM modules/);
    expect(src).toContain('APPLY = process.argv.includes("--apply")');
  });
});

describe("模块采购与赛题关联", () => {
  it("购买链接与平台为可选（自制模块可留空）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/module-schema.ts", "utf8");
    expect(src).toContain("purchase_url: z.string().optional()");
    expect(src).toContain("purchase_platform: z.string().optional()");
    expect(src).toContain("自制/实验室自研模块可以没有价格与链接");
  });

  it("历届应用可关联题库中的题目", async () => {
    const fs = await import("node:fs");
    const schema = fs.readFileSync("lib/module-schema.ts", "utf8");
    expect(schema).toContain("problem_id: z.string().optional()");
    const ui = fs.readFileSync("components/AdminClient.tsx", "utf8");
    expect(ui).toContain("problemOptions");
    expect(ui).toContain("— 手工填写 —");   // 兼容不在题库里的历史数据
  });

  it("模块卡片无价格时不显示 ¥undefined", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/pages-core.tsx", "utf8");
    expect(src).toContain('m.price != null && m.price !== ""');
    expect(src).toContain("自制 / 未标价");
    expect(src).toContain("购买 ↗");
  });

  it("I2C 地址只在协议为 I2C 时显示", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/AdminClient.tsx", "utf8");
    expect(src).toContain('String(it.interface_type || "").toUpperCase() === "I2C"');
    expect(src).toContain("地址只对 I2C 有意义");
  });

  it("采用未发布题目时给出可操作提示", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/pages-build.tsx", "utf8");
    expect(src).toContain("还没完成解析与复核");
    expect(src).toContain("可以先把题面粘贴到下方对话框");
  });
});
