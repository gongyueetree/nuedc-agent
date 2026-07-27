/** 批量提取赛题的结构化需求。
 *
 *  背景：题库里 200 多道题都只有题面原文，需要逐题跑双模复核提取成
 *  结构化需求与评分项。手工在后台一道道点不现实，本脚本批量处理，
 *  但**不自动发布** —— 提取结果仍需工程师逐条确认后才能发布。
 *
 *  成本提醒：每题一次提取（双模复核为两次模型调用）。
 *  跑之前先用 --dry 看清楚会处理多少题、预估多少次调用。
 *
 *  用法：
 *    看看会处理哪些题（不调用模型）
 *      npx tsx scripts/batch-extract.mts --dry
 *    只跑近三年
 *      npx tsx scripts/batch-extract.mts --year=2023,2024,2025
 *    限量试跑
 *      npx tsx scripts/batch-extract.mts --limit=5
 *    正式批量
 *      npx tsx scripts/batch-extract.mts --limit=50 --concurrency=2
 *
 *  中断后重跑会自动跳过已提取的题，可安全续跑。
 */
import { db, ensureSchema, closeDb } from "../lib/db";
import { getDraftVersion, saveExtraction } from "../lib/problem-center";
import { modelGateway } from "../lib/model-gateway";

const args = process.argv.slice(2);
const has = (k: string) => args.includes(k);
const val = (k: string) => args.find((a) => a.startsWith(`${k}=`))?.split("=")[1];

const DRY = has("--dry");
const LIMIT = Number(val("--limit") || 0);
const CONCURRENCY = Math.max(1, Math.min(Number(val("--concurrency") || 2), 4));
const YEARS = (val("--year") || "").split(",").map((s) => Number(s.trim())).filter(Boolean);
const REDO = has("--redo");   // 重新提取已有需求的题

interface Target {
  problem_id: string; year: number; code: string; title: string;
  version_id: string; raw_len: number; req_count: number;
}

const EXTRACT_SYSTEM = `你从电子设计竞赛赛题原文中提取结构化信息。

【最重要：不确定就留空，绝不编造】
1. 只提取原文明确写出的内容。原文没写的指标、数值、条件一律不填
2. 数值必须连同单位与测试条件一起提取，条件缺失时在 note 里说明
3. 分不清是基本要求还是发挥部分时，标 uncertain 而不是猜
4. source_quote 必须是题面里真实存在的原句片段，不得改写或概括 ——
   审核人要靠它逐条比对，写错比留空更糟

【输出 JSON】
{
  "requirements": [
    { "requirement_no": "1.1", "type": "basic|advanced|uncertain",
      "description": "原文表述", "target": 数值或null, "unit": "单位或null",
      "tolerance": "误差要求或null", "verification_method": "measurement|inspection|demo|null",
      "source_quote": "该条需求对应的题面原句（必填，用于人工核对与发布审查）",
      "note": "补充说明或null" }
  ],
  "scoring_items": [
    { "item": "评分项名称", "points": 分值, "section": "设计报告|基本要求|发挥部分|其他" }
  ],
  "notes": [ { "kind": "说明|限制|器材", "content": "原文内容" } ]
}

只输出 JSON，不要任何解释文字。`;

async function pickTargets(): Promise<Target[]> {
  const where: string[] = [];
  const params: any[] = [];
  if (YEARS.length) {
    where.push(`p.year IN (${YEARS.map(() => "?").join(",")})`);
    params.push(...YEARS);
  }

  const rs = await db().execute({
    sql: `SELECT p.problem_id, p.year, p.code, p.title,
            v.version_id, COALESCE(LENGTH(v.raw_text), 0) raw_len,
            (SELECT COUNT(*) FROM problem_requirements r WHERE r.version_id = v.version_id) req_count
          FROM official_problems p
          JOIN problem_versions v ON v.problem_id = p.problem_id
          WHERE v.status != 'published'
            AND v.raw_text IS NOT NULL AND LENGTH(v.raw_text) > 80
            ${where.length ? "AND " + where.join(" AND ") : ""}
          ORDER BY p.year DESC, p.code`,
    args: params,
  });

  let list = (rs.rows as unknown as Target[]).map((r) => ({
    ...r, raw_len: Number(r.raw_len), req_count: Number(r.req_count),
  }));
  // 已提取过的默认跳过，可安全续跑
  if (!REDO) list = list.filter((t) => t.req_count === 0);
  if (LIMIT > 0) list = list.slice(0, LIMIT);
  return list;
}

async function extractOne(t: Target): Promise<{
  ok: boolean; reqs: number; items: number; error?: string; noScoringSource?: boolean;
}> {
  const v = await db().execute({
    sql: "SELECT raw_text FROM problem_versions WHERE version_id=?",
    args: [t.version_id],
  });
  const raw = String((v.rows[0] as any)?.raw_text || "");
  if (raw.length < 80) return { ok: false, reqs: 0, items: 0, error: "题面过短" };

  // PROBLEM_STRUCTURE 已配 requiresHumanReview，与「提取后必须人工确认」一致
  const res = await modelGateway.run({
    taskType: "PROBLEM_STRUCTURE" as any,
    system: EXTRACT_SYSTEM,
    messages: [{ role: "user", content: raw.slice(0, 12000) }],
    maxTokens: 4000,
    schemaMode: "warn",
  } as any);

  if (!res.ok || !res.output) {
    return { ok: false, reqs: 0, items: 0, error: res.message || "模型未返回有效结果" };
  }

  const out: any = res.output;
  const reqs = Array.isArray(out.requirements) ? out.requirements : [];
  const items = Array.isArray(out.scoring_items) ? out.scoring_items : [];
  if (!reqs.length) return { ok: false, reqs: 0, items: 0, error: "未提取到任何需求" };

  // 题面本身没有评分表时，评分项为空是数据源的限制而非提取失败 ——
  // eetree 导出的评审标准填充率仅 3%，完整评分表在官方 PDF 里
  const hasScoringText = /评分|分值|满分|\d+\s*分/.test(raw);

  // 兜底：模型偶尔漏给 source_quote，用描述在原文中反查一段上下文。
  // 找不到就留空 —— 宁可让发布清单拦下，也不编一段引用。
  for (const r of reqs) {
    if (r.source_quote && String(r.source_quote).trim()) continue;
    const key = String(r.description || "").slice(0, 12);
    const at = key.length >= 6 ? raw.indexOf(key) : -1;
    if (at >= 0) r.source_quote = raw.slice(Math.max(0, at - 20), at + 120).trim();
  }

  await saveExtraction(t.version_id, {
    rawText: raw,
    requirements: reqs,
    scoringItems: items,
    // saveExtraction 收的是 ambiguities（待澄清项），模型输出的 notes 归入此处
    ambiguities: Array.isArray(out.notes) ? out.notes : [],
  });

  return { ok: true, reqs: reqs.length, items: items.length, noScoringSource: !hasScoringText };
}

async function main() {
  await ensureSchema();
  const targets = await pickTargets();

  console.log(`待提取 ${targets.length} 题` +
    `${YEARS.length ? `（限 ${YEARS.join("/")} 年）` : ""}` +
    `${LIMIT ? `（限量 ${LIMIT}）` : ""}\n`);

  if (!targets.length) {
    console.log("没有需要提取的题目。");
    console.log("（默认跳过已有需求的题；要重新提取请加 --redo）");
    await closeDb();
    return;
  }

  if (DRY) {
    for (const t of targets.slice(0, 30)) {
      console.log(`  ${t.year} ${t.code.padEnd(9)} ${t.title.slice(0, 28).padEnd(30)} 题面 ${t.raw_len} 字`);
    }
    if (targets.length > 30) console.log(`  …还有 ${targets.length - 30} 题`);
    console.log(`\n预估模型调用：约 ${targets.length} 次（双模复核则翻倍）`);
    console.log("（--dry 模式，未调用模型也未写库）");
    await closeDb();
    return;
  }

  const mock = process.env.ENABLE_MOCK_PROVIDER === "1";
  if (mock) console.log("⚠ ENABLE_MOCK_PROVIDER=1，本次使用 mock 模型，结果不可用于生产\n");

  let ok = 0, failed = 0, noScoring = 0;
  const failures: string[] = [];
  const queue = [...targets];

  // 并发受限：批量提取是长任务，太高的并发容易触发限流
  async function worker(id: number) {
    for (;;) {
      const t = queue.shift();
      if (!t) return;
      const label = `${t.year} ${t.code} ${t.title.slice(0, 20)}`;
      try {
        const r = await extractOne(t);
        if (r.ok) {
          ok++;
          if (r.noScoringSource) noScoring++;
          const scoringNote = r.items > 0 ? `、评分项 ${r.items} 项`
            : r.noScoringSource ? "（题面无评分表，需补 PDF）" : "、评分项 0 项";
          console.log(`  ✓ ${label} → 需求 ${r.reqs} 条${scoringNote}`);
        } else {
          failed++;
          failures.push(`${label}：${r.error}`);
          console.log(`  ✗ ${label} → ${r.error}`);
        }
      } catch (e: any) {
        failed++;
        const msg = String(e?.message || e).slice(0, 100);
        failures.push(`${label}：${msg}`);
        console.log(`  ✗ ${label} → ${msg}`);
      }
    }
  }

  const started = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  const mins = ((Date.now() - started) / 60000).toFixed(1);

  console.log(`\n完成：成功 ${ok} 题、失败 ${failed} 题，耗时 ${mins} 分钟`);
  if (noScoring) {
    console.log(`\n其中 ${noScoring} 题的题面不含评分表 —— 这是导入数据的限制，不是提取失败。`);
    console.log("完整评分标准在官方 PDF 里；这些题可在后台上传 PDF 重新提取以补全评分项。");
  }
  if (failures.length) {
    console.log("\n失败明细：");
    for (const f of failures.slice(0, 15)) console.log(`  ${f}`);
    if (failures.length > 15) console.log(`  …还有 ${failures.length - 15} 条`);
    console.log("\n失败的题可重跑本脚本，已成功的会自动跳过。");
  }
  console.log("\n提取结果均为草稿，需到 /admin/problems 逐条确认后发布。");
  console.log("发布前用户无法选用这些题目。");

  await closeDb();
}

main().catch(async (e: any) => {
  if (e?.code === "TRANSACTION_DRIVER_UNAVAILABLE" || /DATABASE_URL/.test(String(e?.message))) {
    console.error("未配置数据库连接。请先设置：");
    console.error("  export $(grep '^DATABASE_URL=' .env.local | xargs)");
    console.error("或直接指定：DATABASE_URL='postgresql://…' npm run batch-extract -- --dry");
  } else {
    console.error(e);
  }
  await closeDb().catch(() => {});
  process.exit(1);
});
