/** 题库去重。
 *
 *  重复来源：早期导入用纯题号（2024 A），后续导入区分了场次（2024 A-决赛），
 *  同一道题因此产生多条记录。前端表现为同名按钮重复出现多次。
 *
 *  去重策略：按「年份 + 标题」分组（标题才是题目的真实身份，
 *  题号会因初赛/决赛、不同来源而不一致）。组内保留信息最全的一条：
 *  已发布 > 有需求 > 有版本 > 有题面 > 创建最早。
 *
 *  用法：
 *    干跑，只列出重复不删除
 *      npx tsx scripts/dedupe-problems.mts
 *    实际清理
 *      npx tsx scripts/dedupe-problems.mts --apply
 */
import { db, ensureSchema, closeDb } from "../lib/db";
import { deleteProblem } from "../lib/problem-center";

const APPLY = process.argv.includes("--apply");
/** 同年同名但题号不同的也一并去重（默认关闭 —— 那通常是不同组别的题） */
const INCLUDE_SAME_TITLE = process.argv.includes("--include-same-title");

interface Row {
  problem_id: string; year: number; code: string; title: string;
  status: string; versions: number; requirements: number;
  published: number; has_raw: number; created_at: string;
}

/** 评分越高越该保留 */
function score(r: Row): number {
  // 计数字段经数据库驱动返回可能是字符串，统一转数字
  return (Number(r.published) > 0 ? 10000 : 0)
    + Math.min(Number(r.requirements) || 0, 999) * 10
    + (Number(r.versions) > 0 ? 50 : 0)
    + (Number(r.has_raw) > 0 ? 20 : 0);
}

const fmt = (r: Row) =>
  `版本${Number(r.versions) || 0} 需求${Number(r.requirements) || 0}` +
  `${Number(r.published) > 0 ? " 已发布" : ""}${Number(r.has_raw) > 0 ? " 有题面" : ""}`;

async function main() {
  await ensureSchema();

  const rs = await db().execute({
    sql: `SELECT p.problem_id, p.year, p.code, p.title, p.status, p.created_at,
            (SELECT COUNT(*) FROM problem_versions v WHERE v.problem_id=p.problem_id) versions,
            (SELECT COUNT(*) FROM problem_versions v WHERE v.problem_id=p.problem_id AND v.status='published') published,
            (SELECT COUNT(*) FROM problem_requirements r
               JOIN problem_versions v2 ON v2.version_id=r.version_id
               WHERE v2.problem_id=p.problem_id) requirements,
            (SELECT COUNT(*) FROM problem_versions v3
               WHERE v3.problem_id=p.problem_id AND v3.raw_text IS NOT NULL AND LENGTH(v3.raw_text) > 50) has_raw
          FROM official_problems p
          ORDER BY p.year DESC, p.title, p.created_at`,
    args: [],
  });
  const rows = rs.rows as unknown as Row[];
  console.log(`题库共 ${rows.length} 条\n`);

  // 分两类：
  //   确定重复 —— 年份、题号、标题三者完全相同，只可能是重复导入
  //   疑似重复 —— 年份与标题相同但题号不同，很可能是同一年本科组与
  //               高职高专组的同名题（如 2019 H 与 J），删掉会丢数据，
  //               因此默认不动，需显式 --include-same-title 才处理
  const exact = new Map<string, Row[]>();
  const sameTitle = new Map<string, Row[]>();
  for (const r of rows) {
    const ek = `${r.year}|${String(r.code).trim()}|${String(r.title).trim()}`;
    if (!exact.has(ek)) exact.set(ek, []);
    exact.get(ek)!.push(r);

    const tk = `${r.year}|${String(r.title).trim()}`;
    if (!sameTitle.has(tk)) sameTitle.set(tk, []);
    sameTitle.get(tk)!.push(r);
  }

  const dups = [...exact.entries()].filter(([, v]) => v.length > 1);

  // 同名但题号不同的，单独列出供人工判断
  const suspicious = [...sameTitle.entries()]
    .filter(([, v]) => v.length > 1 && new Set(v.map((x) => x.code)).size > 1);
  if (suspicious.length) {
    console.log(`⚠ ${suspicious.length} 组「同年同名但题号不同」，很可能是本科组与高职组的同名题，默认不处理：`);
    for (const [key, list] of suspicious) {
      const [year, title] = key.split("|");
      console.log(`  ${year} · ${title.slice(0, 30)} → 题号 ${list.map((x) => x.code).join(" / ")}`);
    }
    console.log("  （确属重复请人工在后台删除，或加 --include-same-title）\n");
  }

  if (!dups.length) {
    console.log("没有发现完全重复的题目。");
    await closeDb();
    return;
  }

  const totalExtra = dups.reduce((a, [, v]) => a + v.length - 1, 0);
  console.log(`发现 ${dups.length} 组完全重复（年份+题号+标题相同），共 ${totalExtra} 条冗余：\n`);

  const toDelete: Row[] = [];
  const targets = INCLUDE_SAME_TITLE
    ? [...dups, ...suspicious.map(([k, v]) => [k.split("|")[0] + "||" + k.split("|")[1], v] as [string, Row[]])]
    : dups;
  for (const [key, list] of targets) {
    const sorted = [...list].sort((a, b) => score(b) - score(a)
      || String(a.created_at).localeCompare(String(b.created_at)));
    const keep = sorted[0];
    const drop = sorted.slice(1);
    toDelete.push(...drop);

    const [year, code2, title] = key.split("|");
    console.log(`${year} ${code2} · ${title.slice(0, 30)}（${list.length} 条）`);
    console.log(`  保留 ${keep.code.padEnd(10)} ${fmt(keep)}`);
    for (const d of drop) console.log(`  删除 ${d.code.padEnd(10)} ${fmt(d)}`);
  }

  if (!APPLY) {
    console.log(`\n（干跑模式，未删除任何内容。加 --apply 执行清理）`);
    await closeDb();
    return;
  }

  console.log(`\n开始清理 ${toDelete.length} 条…`);
  let ok = 0, failed = 0;
  for (const d of toDelete) {
    // 保留项优先级已算过，这里的都是冗余项；用 force 跳过引用检查
    const r = await deleteProblem(d.problem_id, { force: true });
    if (r.ok) { ok++; } else { failed++; console.error(`  ✗ ${d.year} ${d.code}：${r.error}`); }
  }
  console.log(`\n完成：删除 ${ok} 条${failed ? `，失败 ${failed} 条` : ""}`);

  const after = await db().execute({ sql: "SELECT COUNT(*) n FROM official_problems", args: [] });
  console.log(`题库现有 ${(after.rows[0] as any).n} 条`);
  await closeDb();
}

main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
