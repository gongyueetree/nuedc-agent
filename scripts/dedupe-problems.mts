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

interface Row {
  problem_id: string; year: number; code: string; title: string;
  status: string; versions: number; requirements: number;
  published: number; has_raw: number; created_at: string;
}

/** 评分越高越该保留 */
function score(r: Row): number {
  return (r.published > 0 ? 10000 : 0)
    + Math.min(r.requirements, 999) * 10
    + (r.versions > 0 ? 50 : 0)
    + (r.has_raw > 0 ? 20 : 0);
}

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

  // 按 年份 + 标题 分组（标题是真实身份，题号会因场次/来源而不一致）
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.year}|${String(r.title).trim()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const dups = [...groups.entries()].filter(([, v]) => v.length > 1);
  if (!dups.length) {
    console.log("没有发现重复题目。");
    await closeDb();
    return;
  }

  const totalExtra = dups.reduce((a, [, v]) => a + v.length - 1, 0);
  console.log(`发现 ${dups.length} 组重复，共 ${totalExtra} 条冗余记录：\n`);

  const toDelete: Row[] = [];
  for (const [key, list] of dups) {
    const sorted = [...list].sort((a, b) => score(b) - score(a)
      || String(a.created_at).localeCompare(String(b.created_at)));
    const keep = sorted[0];
    const drop = sorted.slice(1);
    toDelete.push(...drop);

    const [year, title] = key.split("|");
    console.log(`${year} · ${title.slice(0, 34)}（${list.length} 条）`);
    console.log(`  保留 ${keep.code.padEnd(10)} 版本${keep.versions} 需求${keep.requirements}${keep.published ? " 已发布" : ""}`);
    for (const d of drop) {
      console.log(`  删除 ${d.code.padEnd(10)} 版本${d.versions} 需求${d.requirements}${d.published ? " 已发布" : ""}`);
    }
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
