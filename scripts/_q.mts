import { db, ensureSchema, closeDb } from "../lib/db";

async function main() {
  await ensureSchema();
  const t = await db().execute({ sql: "SELECT COUNT(*) n FROM official_problems", args: [] });
  console.log("题目总数:", (t.rows[0] as any).n);

  const nv = await db().execute({
    sql: `SELECT COUNT(*) n FROM official_problems p
          WHERE NOT EXISTS (SELECT 1 FROM problem_versions v WHERE v.problem_id=p.problem_id)`,
    args: [],
  });
  console.log("无版本的题目:", (nv.rows[0] as any).n);

  const raw = await db().execute({
    sql: "SELECT COUNT(*) n FROM problem_versions WHERE raw_text IS NOT NULL",
    args: [],
  });
  console.log("有题面原文的版本:", (raw.rows[0] as any).n);

  const sample = await db().execute({
    sql: `SELECT year, code, title, status FROM official_problems ORDER BY year DESC LIMIT 5`,
    args: [],
  });
  console.log("样例:");
  for (const r of sample.rows as any[]) {
    console.log(`  ${r.year} ${r.code} ${String(r.title).slice(0, 24)} · ${r.status}`);
  }
  await closeDb();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
