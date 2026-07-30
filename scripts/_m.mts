import { db, ensureSchema, closeDb } from "../lib/db";

async function main() {
  await ensureSchema();
  const t = await db().execute({ sql: "SELECT COUNT(*) n FROM modules", args: [] });
  console.log("模块总数:", (t.rows[0] as any).n);

  const cols = await db().execute({
    sql: "SELECT column_name FROM information_schema.columns WHERE table_name='modules' ORDER BY column_name",
    args: [],
  });
  const names = (cols.rows as any[]).map((r) => String(r.column_name));
  console.log("列:", names.join(", "));
  for (const c of ["scope", "owner_ref", "org_ref"]) {
    console.log(`  ${c}: ${names.includes(c) ? "有" : "❌ 缺失"}`);
  }

  const byScope = await db().execute({
    sql: "SELECT COALESCE(scope,'(null)') s, COUNT(*) n FROM modules GROUP BY scope",
    args: [],
  }).catch((e: any) => ({ rows: [{ s: "查询失败: " + e.message, n: 0 }] }));
  console.log("按 scope 分布:");
  for (const r of byScope.rows as any[]) console.log(`  ${r.s}: ${r.n}`);

  const sample = await db().execute({
    sql: "SELECT id, name, certification_status FROM modules LIMIT 5", args: [],
  });
  console.log("样例:");
  for (const r of sample.rows as any[]) console.log(`  ${r.id} · ${r.name} · ${r.certification_status}`);

  await closeDb();
}
main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
