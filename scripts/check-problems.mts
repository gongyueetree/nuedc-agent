/** 快速核对题库状态：有多少题、多少有版本、多少已发布 */
import { db, ensureSchema, closeDb } from "../lib/db";

await ensureSchema();

const total = await db().execute({ sql: "SELECT COUNT(*) n FROM official_problems", args: [] });
console.log(`题目总数：${(total.rows[0] as any).n}`);

const byStatus = await db().execute({
  sql: "SELECT status, COUNT(*) n FROM official_problems GROUP BY status", args: [],
});
console.log("按状态：");
for (const r of byStatus.rows as any[]) console.log(`  ${r.status}: ${r.n}`);

const versions = await db().execute({
  sql: `SELECT v.status, COUNT(*) n FROM problem_versions v GROUP BY v.status`, args: [],
});
console.log("版本状态：");
for (const r of versions.rows as any[]) console.log(`  ${r.status}: ${r.n}`);

const noVersion = await db().execute({
  sql: `SELECT COUNT(*) n FROM official_problems p
        WHERE NOT EXISTS (SELECT 1 FROM problem_versions v WHERE v.problem_id = p.problem_id)`,
  args: [],
});
console.log(`\n无任何版本的题目：${(noVersion.rows[0] as any).n}（这些题「打开」会提示没有版本）`);

const withRaw = await db().execute({
  sql: `SELECT COUNT(*) n FROM problem_versions WHERE raw_text IS NOT NULL AND LENGTH(raw_text) > 50`,
  args: [],
});
console.log(`已有题面原文的版本：${(withRaw.rows[0] as any).n}（可直接执行提取）`);

const sample = await db().execute({
  sql: `SELECT p.year, p.code, p.title, p.status,
          (SELECT COUNT(*) FROM problem_versions v WHERE v.problem_id=p.problem_id) vn
        FROM official_problems p ORDER BY p.year DESC, p.code LIMIT 8`,
  args: [],
});
console.log("\n最新几条：");
for (const r of sample.rows as any[]) {
  console.log(`  ${r.year} ${r.code} ${String(r.title).slice(0, 26)} · ${r.status} · ${r.vn} 个版本`);
}

await closeDb();
