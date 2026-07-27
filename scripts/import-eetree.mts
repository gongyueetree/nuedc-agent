/** 把 eetree 导出的赛题 JSON 映射进赛题中心。
 *
 *  eetree 导出格式（中文字段名）：
 *    年份 "2025年" / 题号 "A题" / 题目名称 / 组别 / 任务 / 要求 / 评审标准 / PDF 地址 []
 *
 *  处理策略：
 *  - 任务 + 要求 + 评审标准拼成题面原文，存入草稿版本的 raw_text，
 *    后续由双模复核提取成结构化需求（与上传 PDF 的路径完全一致）
 *  - PDF 地址存入 source_url；有 PDF 的题优先用 PDF 重新提取，
 *    因为组委会原件比二手文本更权威、且含完整评分表
 *  - 技术方向按标题与题面自动建议，仍需工程师在后台确认
 *  - 组别缺失（导出中仅 5% 有值）时留空，不猜
 *
 *  用法：
 *    干跑，只看解析结果不写库
 *      npx tsx scripts/import-eetree.mts nuedc-tasks-export.json --dry
 *    实际导入
 *      DATABASE_URL=... npx tsx scripts/import-eetree.mts nuedc-tasks-export.json
 *    只导入指定年份
 *      DATABASE_URL=... npx tsx scripts/import-eetree.mts export.json --year=2024
 */
import { readFileSync } from "node:fs";
import { db, ensureSchema, closeDb } from "../lib/db";
import { createProblem, createDraftVersion, saveExtraction } from "../lib/problem-center";
import { suggestTechTags, TECH_LABEL, type TechCategory } from "../lib/problem-taxonomy";

interface EetreeRow {
  "年份": string;
  "题号": string;
  "题目名称": string;
  "组别"?: string;
  "任务"?: string;
  "要求"?: string;
  "评审标准"?: string;
  "PDF 地址"?: string[] | string;
}

interface Mapped {
  year: number;
  code: string;
  title: string;
  group?: string;
  /** 场次：初赛/决赛、7月/10月等。同年同题号可能有多场，必须区分 */
  stage?: string;
  rawText: string;
  pdfUrl?: string;
  tech: TechCategory[];
  hasScoring: boolean;
}

/** 题目名称里混着元信息，需要清洗出真正的标题与场次。
 *  实测样例：
 *    "2024年决赛_A题：集成运放参数测试仪"      → 决赛
 *    "2022年_7月_A题 ：单相逆变器并联运行系统"  → 7月
 *    "AC-AC变换电路并联运行【本科组/高职组】"   → 组别信息在标题里
 */
function cleanTitle(raw: string): { title: string; stage?: string; group?: string } {
  let t = String(raw || "").trim();
  let stage: string | undefined;
  let group: string | undefined;

  // 场次：决赛 / 复赛 / N月
  const stageMatch = t.match(/(决赛|复赛|初赛)/) || t.match(/_(\d{1,2})月_/);
  if (stageMatch) stage = stageMatch[1].match(/^\d+$/) ? `${stageMatch[1]}月` : stageMatch[1];

  // 剥掉 "2024年决赛_A题：" / "2022年_7月_A题 ：" 这类前缀
  t = t.replace(/^\d{4}\s*年[_\s-]*(?:决赛|复赛|初赛)?[_\s-]*(?:\d{1,2}月)?[_\s-]*[A-Za-z]\d?\s*题\s*[：:\-]?\s*/, "");

  // 提取并剥掉【本科组/高职组】这类尾注
  const groupMatch = t.match(/【([^】]*(?:本科|高职|专科)[^】]*)】/);
  if (groupMatch) { group = groupMatch[1].trim(); t = t.replace(groupMatch[0], ""); }
  t = t.replace(/【[^】]*】/g, "").trim();

  return { title: t || String(raw).trim(), stage, group };
}

/** "2025年" → 2025；"A题" → "A" */
function parseYear(raw: string): number | null {
  const m = String(raw || "").match(/(\d{4})/);
  return m ? Number(m[1]) : null;
}
function parseCode(raw: string): string | null {
  const m = String(raw || "").match(/([A-Za-z]\d?)/);
  return m ? m[1].toUpperCase() : null;
}
function firstUrl(raw: unknown): string | undefined {
  if (Array.isArray(raw)) return raw.find((x) => typeof x === "string" && x.startsWith("http"));
  if (typeof raw === "string" && raw.startsWith("http")) return raw;
  return undefined;
}

export function mapRow(row: EetreeRow): { ok: true; data: Mapped } | { ok: false; reason: string } {
  const year = parseYear(row["年份"]);
  const code = parseCode(row["题号"]);
  const cleaned = cleanTitle(row["题目名称"]);
  if (!year) return { ok: false, reason: `无法解析年份：${row["年份"]}` };
  if (!code) return { ok: false, reason: `无法解析题号：${row["题号"]}` };
  if (!cleaned.title) return { ok: false, reason: "题目名称为空" };
  const title = cleaned.title;

  // 拼成题面原文，保留原有分节标题，便于提取时定位
  const parts: string[] = [];
  const task = String(row["任务"] || "").trim();
  const req = String(row["要求"] || "").trim();
  const scoring = String(row["评审标准"] || "").trim();
  if (task) parts.push(`一、任务\n${task}`);
  if (req) parts.push(`二、要求\n${req}`);
  if (scoring) parts.push(`三、评分标准\n${scoring}`);

  const rawText = parts.join("\n\n");
  if (!rawText) return { ok: false, reason: "任务与要求均为空" };

  return {
    ok: true,
    data: {
      year, code, title,
      stage: cleaned.stage,
      // 导出中组别仅 5% 有值，标题里的【本科组】作为补充来源
      group: String(row["组别"] || "").trim() || cleaned.group,
      rawText,
      pdfUrl: firstUrl(row["PDF 地址"]),
      tech: suggestTechTags(title, rawText.slice(0, 2000)),
      hasScoring: !!scoring,
    },
  };
}

async function main() {
  const file = process.argv[2];
  const dry = process.argv.includes("--dry");
  const yearArg = process.argv.find((a) => a.startsWith("--year="));
  const onlyYear = yearArg ? Number(yearArg.split("=")[1]) : null;

  if (!file && !process.argv.includes("--repair-schema")) {
    console.error("用法: import-eetree.mts <export.json> [--dry] [--year=2024]");
    console.error("      import-eetree.mts --repair-schema   # 补齐缺失的分类列");
    process.exit(2);
  }

  if (process.argv.includes("--repair-schema")) {
    await ensureSchema();

    // 先诊断：迁移记录与实际列是否一致
    const mig = await db().execute({
      sql: "SELECT id, name, applied_at FROM schema_migrations ORDER BY id DESC LIMIT 6",
      args: [],
    });
    console.log("最近的迁移记录：");
    for (const r of mig.rows as any[]) {
      console.log(`  ${r.id} ${r.name}  ${String(r.applied_at).slice(0, 19)}`);
    }
    const before = await db().execute({
      sql: "SELECT column_name FROM information_schema.columns WHERE table_name='official_problems'",
      args: [],
    });
    const beforeCols = (before.rows as any[]).map((r) => String(r.column_name));
    console.log(`\n当前 official_problems 列：${beforeCols.join(", ")}`);
    const has21 = (mig.rows as any[]).some((r) => Number(r.id) === 21);
    const hasCol = beforeCols.includes("contest_type");
    if (has21 && !hasCol) {
      console.log("\n⚠ 迁移 21 已记录但列不存在 —— 说明此前有一次执行中途失败，");
      console.log("  记录写入了而 DDL 未落库。下面直接补列修复。");
    }

    console.log("\n修复 official_problems 的分类列…");
    const stmts = [
      "ALTER TABLE official_problems ADD COLUMN IF NOT EXISTS contest_type TEXT DEFAULT 'national'",
      "ALTER TABLE official_problems ADD COLUMN IF NOT EXISTS region TEXT",
      "ALTER TABLE official_problems ADD COLUMN IF NOT EXISTS tech_tags TEXT",
      "ALTER TABLE official_problems ADD COLUMN IF NOT EXISTS source_url TEXT",
      "ALTER TABLE official_problems ADD COLUMN IF NOT EXISTS difficulty TEXT",
      "CREATE INDEX IF NOT EXISTS idx_problems_contest ON official_problems(contest_type, year)",
      "CREATE INDEX IF NOT EXISTS idx_problems_year_code ON official_problems(year DESC, code)",
    ];
    for (const st of stmts) {
      try { await db().execute(st); console.log(`  ✓ ${st.slice(0, 62)}…`); }
      catch (e: any) { console.error(`  ✗ ${st.slice(0, 50)}… ${String(e?.message || e).slice(0, 80)}`); }
    }
    const after = await db().execute({
      sql: "SELECT column_name FROM information_schema.columns WHERE table_name='official_problems'",
      args: [],
    });
    const names = (after.rows as any[]).map((r) => String(r.column_name));
    console.log(`\n当前列：${names.join(", ")}`);
    console.log("\n修复完成，重新运行导入即可。");
    return;
  }

  const rows: EetreeRow[] = JSON.parse(readFileSync(file, "utf8"));
  console.log(`读入 ${rows.length} 条\n`);

  const mapped: Mapped[] = [];
  const failed: { row: EetreeRow; reason: string }[] = [];
  for (const r of rows) {
    const m = mapRow(r);
    if (!m.ok) { failed.push({ row: r, reason: m.reason }); continue; }
    if (onlyYear && m.data.year !== onlyYear) continue;
    mapped.push(m.data);
  }

  // 解析概览
  const withPdf = mapped.filter((m) => m.pdfUrl).length;
  const withScoring = mapped.filter((m) => m.hasScoring).length;
  const noTech = mapped.filter((m) => !m.tech.length).length;
  console.log(`可导入 ${mapped.length} 条${onlyYear ? `（${onlyYear} 年）` : ""}`);
  console.log(`  有 PDF 地址：${withPdf}（${Math.round(withPdf / Math.max(mapped.length, 1) * 100)}%）`);
  console.log(`  含评分标准：${withScoring}`);
  console.log(`  未识别技术方向：${noTech}（导入后需人工补标）`);
  if (failed.length) {
    console.log(`\n跳过 ${failed.length} 条：`);
    for (const f of failed.slice(0, 8)) {
      console.log(`  ${f.row["年份"]}${f.row["题号"]} ${String(f.row["题目名称"]).slice(0, 24)} — ${f.reason}`);
    }
  }

  if (dry) {
    console.log("\n--- 样例（前 3 条）---");
    for (const m of mapped.slice(0, 3)) {
      console.log(`\n${m.year} ${m.code} · ${m.title}`);
      console.log(`  场次：${m.stage || "（常规）"}　组别：${m.group || "（未标注）"}`);
      console.log(`  方向：${m.tech.map((t) => TECH_LABEL[t]).join(" / ") || "（未识别）"}`);
      console.log(`  PDF：${m.pdfUrl || "无"}`);
      console.log(`  题面：${m.rawText.replace(/\n/g, " ").slice(0, 100)}…（${m.rawText.length} 字）`);
    }
    console.log("\n（--dry 模式，未写入数据库）");
    return;
  }

  await ensureSchema();

  // 导入前先验证 schema：缺列时立刻停止并给出修复方式，
  // 而不是让 199 条记录逐一失败、刷屏同一条错误
  const REQUIRED = ["contest_type", "region", "tech_tags", "source_url"];
  const cols = await db().execute({
    sql: "SELECT column_name FROM information_schema.columns WHERE table_name='official_problems'",
    args: [],
  });
  const have = new Set(cols.rows.map((r: any) => String(r.column_name)));
  const missing = REQUIRED.filter((c) => !have.has(c));
  if (missing.length) {
    console.error(`\n❌ official_problems 缺少列：${missing.join(", ")}`);
    console.error("   迁移 21 未生效。ensureSchema 已执行，说明 schema_migrations 里");
    console.error("   可能已有该迁移的记录，但 DDL 实际没落库（中途失败留下的不一致）。");
    console.error("\n   修复：");
    console.error("     DATABASE_URL='...' npm run import-eetree -- --repair-schema");
    console.error("   或手工执行：");
    for (const c of missing) {
      const type = c === "tech_tags" || c === "source_url" || c === "region" ? "TEXT"
        : "TEXT DEFAULT 'national'";
      console.error(`     ALTER TABLE official_problems ADD COLUMN IF NOT EXISTS ${c} ${type};`);
    }
    process.exit(1);
  }

  let created = 0, skipped = 0, failedWrite = 0;

  for (const m of mapped) {
    try {
      // 同年同题号可能有多场（2024 初赛/决赛、2022 七月/十月），
      // 必须连标题一起比对，否则会把不同的题误判成重复而丢掉
      const dup = await db().execute({
        sql: "SELECT problem_id FROM official_problems WHERE year=? AND code=? AND title=? LIMIT 1",
        args: [m.year, m.code, m.title],
      });
      if (dup.rows.length) { skipped++; continue; }

      const problemId = await createProblem({
        // 有场次时题号带后缀（A-决赛、A-10月），避免同年同号冲突
        year: m.year, code: m.stage ? `${m.code}-${m.stage}` : m.code, title: m.title,
        groupName: m.group, createdBy: "eetree_import",
        contestType: "national", techTags: m.tech,
        sourceUrl: m.pdfUrl,
      });
      const versionId = await createDraftVersion(problemId, { rawText: m.rawText });
      // 题面先落库，结构化需求留给双模复核提取 + 工程师确认
      await saveExtraction(versionId, { rawText: m.rawText });
      created++;
      if (created % 25 === 0) console.log(`  已导入 ${created}…`);
    } catch (e: any) {
      failedWrite++;
      console.error(`  ✗ ${m.year}${m.code}：${String(e?.message || e).slice(0, 100)}`);
    }
  }

  console.log(`\n完成：新建 ${created} · 已存在跳过 ${skipped} · 失败 ${failedWrite}`);
  console.log(`\n下一步：到 /admin/problems`);
  console.log(`  1. 对有 PDF 的题优先「上传 PDF」重新提取 —— 组委会原件含完整评分表，比二手文本准确`);
  console.log(`  2. 无 PDF 的题直接对已存题面执行提取`);
  console.log(`  3. 逐条确认需求与评分项，双人审核后发布`);
  console.log(`  发布后用户选题即可零模型调用直接载入。`);
}

if (process.argv[1]?.includes("import-eetree")) {
  main()
    .then(() => closeDb())
    .catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
}
