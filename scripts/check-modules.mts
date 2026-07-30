/** 模块表体检。只用 HTTP 驱动的单条查询，
 *  不走事务、不开 WebSocket —— 连接不稳时也能跑完。 */
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) { console.error("缺少 DATABASE_URL"); process.exit(1); }
const sql = neon(url);

async function main() {
  const total = await sql`SELECT COUNT(*)::int AS n FROM modules`;
  console.log("模块总数:", total[0].n);

  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'modules' ORDER BY column_name`;
  const names = cols.map((r: any) => String(r.column_name));
  console.log("\n关键列:");
  for (const c of ["scope", "owner_ref", "org_ref", "certification_status", "data"]) {
    console.log(`  ${c.padEnd(22)} ${names.includes(c) ? "✓" : "❌ 缺失"}`);
  }

  if (names.includes("scope")) {
    const byScope = await sql`
      SELECT COALESCE(scope, '(NULL)') AS s, COUNT(*)::int AS n FROM modules GROUP BY scope`;
    console.log("\n按 scope 分布:");
    for (const r of byScope as any[]) console.log(`  ${String(r.s).padEnd(14)} ${r.n}`);
    const nulls = (byScope as any[]).find((r) => r.s === "(NULL)");
    if (nulls) {
      console.log(`\n⚠ ${nulls.n} 个模块 scope 为 NULL —— 可见性过滤会把它们当公共模块，但建议补齐`);
    }
  }

  const byCert = await sql`
    SELECT certification_status AS c, COUNT(*)::int AS n FROM modules GROUP BY certification_status`;
  console.log("\n按认证状态:");
  for (const r of byCert as any[]) console.log(`  ${String(r.c).padEnd(20)} ${r.n}`);

  const sample = await sql`SELECT id, name FROM modules ORDER BY id LIMIT 5`;
  console.log("\n样例:");
  for (const r of sample as any[]) console.log(`  ${String(r.id).padEnd(26)} ${r.name}`);
}

main().catch((e) => {
  console.error("查询失败:", e?.message || e);
  process.exit(1);
});
