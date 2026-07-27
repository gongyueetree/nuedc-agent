/** 赛题批量导入。
 *
 *  为什么不内置爬虫：
 *  1. 赛题原文的著作权属于竞赛组委会，第三方站点对其整理与编排也可能主张权利
 *  2. 批量抓取他人服务器通常违反其服务条款，也不礼貌
 *  3. 抓取结果的结构随对方页面改版而失效，不适合作为生产数据通路
 *
 *  合规的数据来源：
 *  - 组委会官网发布的赛题 PDF（推荐，最权威）
 *  - 学校/实验室存档的历年题目
 *  - 与内容方达成授权后由对方提供的结构化数据
 *
 *  用法：
 *    清单导入（只建条目与分类，题面稍后上传 PDF 提取）
 *      DATABASE_URL=... npx tsx scripts/import-problems.mts manifest problems.json
 *
 *    PDF 目录导入（文件名形如 2023-A-题目名称.pdf）
 *      DATABASE_URL=... npx tsx scripts/import-problems.mts pdfdir ./problem-pdfs
 *
 *    导出现有题库（备份/迁移用）
 *      DATABASE_URL=... npx tsx scripts/import-problems.mts export out.json
 *
 *  manifest 格式：
 *  [
 *    { "year": 2023, "code": "A", "title": "单相在线式不间断电源",
 *      "contestType": "national", "group": "本科组",
 *      "tech": ["power"], "sourceUrl": "https://...", "pdf": "./pdfs/2023-A.pdf" }
 *  ]
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { db, ensureSchema, closeDb } from "../lib/db";
import { createProblem, createDraftVersion, pdfSha256, findVersionByPdf, listProblems } from "../lib/problem-center";
import { suggestTechTags, TECH_LABEL, CONTEST_LABEL, type ContestType, type TechCategory } from "../lib/problem-taxonomy";

const cmd = process.argv[2];
const arg = process.argv[3];

interface ManifestItem {
  year: number; code: string; title: string;
  contestType?: ContestType; group?: string; region?: string;
  tech?: TechCategory[]; sourceUrl?: string; pdf?: string;
}

/** 从文件名解析 年份-题号-标题，例如 2023-A-单相在线式不间断电源.pdf */
function parseFileName(name: string): { year: number; code: string; title: string } | null {
  const stem = basename(name, extname(name));
  const m = stem.match(/^(\d{4})[-_\s]+([A-Za-z]\d?)[-_\s]+(.+)$/);
  if (!m) return null;
  return { year: Number(m[1]), code: m[2].toUpperCase(), title: m[3].replace(/[-_]+/g, " ").trim() };
}

async function importOne(item: ManifestItem, pdfPath?: string): Promise<"created" | "exists" | "failed"> {
  try {
    // 同一份 PDF 不重复建条目
    if (pdfPath && existsSync(pdfPath)) {
      const b64 = readFileSync(pdfPath).toString("base64");
      const sha = pdfSha256(b64);
      const dup = await findVersionByPdf(sha);
      if (dup) {
        console.log(`  ⊙ ${item.year}-${item.code} 已存在（同一 PDF），跳过`);
        return "exists";
      }
      const problemId = await createProblem({
        year: item.year, code: item.code, title: item.title,
        groupName: item.group, createdBy: "import",
        contestType: item.contestType, region: item.region,
        techTags: item.tech, sourceUrl: item.sourceUrl,
      });
      await createDraftVersion(problemId, { pdfSha: sha });
      console.log(`  ✓ ${item.year}-${item.code} ${item.title}（已建条目与草稿版本，待提取）`);
      return "created";
    }

    const problemId = await createProblem({
      year: item.year, code: item.code, title: item.title,
      groupName: item.group, createdBy: "import",
      contestType: item.contestType, region: item.region,
      techTags: item.tech, sourceUrl: item.sourceUrl,
    });
    await createDraftVersion(problemId);
    const tags = item.tech?.length ? item.tech : suggestTechTags(item.title);
    console.log(`  ✓ ${item.year}-${item.code} ${item.title} [${tags.map((t) => TECH_LABEL[t]).join("/")}]`);
    return "created";
  } catch (e: any) {
    console.error(`  ✗ ${item.year}-${item.code}：${String(e?.message || e).slice(0, 120)}`);
    return "failed";
  }
}

async function main() {
  // 帮助信息不需要数据库连接
  if (!cmd || !["manifest", "pdfdir", "export"].includes(cmd)) {
    printHelp();
    return;
  }
  await ensureSchema();

  if (cmd === "manifest") {
    if (!arg) { console.error("用法: import-problems.mts manifest <problems.json>"); process.exit(2); }
    const items: ManifestItem[] = JSON.parse(readFileSync(arg, "utf8"));
    console.log(`导入 ${items.length} 条赛题清单…\n`);
    const stat = { created: 0, exists: 0, failed: 0 };
    for (const it of items) {
      if (!it.year || !it.code || !it.title) { console.error(`  ✗ 缺少必填字段：${JSON.stringify(it).slice(0, 80)}`); stat.failed++; continue; }
      stat[await importOne(it, it.pdf)]++;
    }
    console.log(`\n完成：新建 ${stat.created} · 已存在 ${stat.exists} · 失败 ${stat.failed}`);
    console.log("下一步：到 /admin/problems 上传或粘贴题面，执行双模复核提取，人工确认后发布。");
    return;
  }

  if (cmd === "pdfdir") {
    if (!arg) { console.error("用法: import-problems.mts pdfdir <目录>"); process.exit(2); }
    const files = readdirSync(arg).filter((f) => extname(f).toLowerCase() === ".pdf");
    console.log(`扫描到 ${files.length} 个 PDF…\n`);
    const stat = { created: 0, exists: 0, failed: 0 };
    for (const f of files) {
      const parsed = parseFileName(f);
      if (!parsed) {
        console.error(`  ✗ ${f} 文件名不符合「年份-题号-标题.pdf」格式，跳过`);
        stat.failed++;
        continue;
      }
      stat[await importOne({ ...parsed, contestType: "national" }, join(arg, f))]++;
    }
    console.log(`\n完成：新建 ${stat.created} · 已存在 ${stat.exists} · 失败 ${stat.failed}`);
    return;
  }

  if (cmd === "export") {
    const rows = await listProblems({});
    const out = rows.map((r: any) => ({
      year: r.year, code: r.code, title: r.title,
      contestType: r.contest_type, group: r.group_name, region: r.region,
      tech: r.tech_tags, sourceUrl: r.source_url,
      published: !!r.published_version_id, requirements: Number(r.requirement_count || 0),
    }));
    const file = arg || "problems-export.json";
    writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`已导出 ${out.length} 条到 ${file}`);
    return;
  }

  printHelp();
}

function printHelp() {
  console.log(`赛题批量导入

  manifest <file.json>   从清单导入（可含 pdf 路径）
  pdfdir <目录>          扫描目录内 PDF，按文件名「年份-题号-标题.pdf」建条目
  export [file.json]     导出现有题库

赛事类型：${Object.entries(CONTEST_LABEL).map(([k, v]) => `${k}(${v})`).join(" ")}
技术方向：${Object.entries(TECH_LABEL).map(([k, v]) => `${k}(${v})`).join(" ")}

注意：本工具不抓取第三方网站。赛题原文著作权归竞赛组委会所有，
请使用官方发布的 PDF，或在获得授权后由内容方提供结构化数据。`);
}

main()
  .then(() => closeDb())
  .catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
