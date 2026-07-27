/** 修正已入库题目的赛事类型。
 *
 *  背景：导入时全部标成了国赛，但电赛为两年一届 ——
 *  奇数年（2021/2023/2025）为全国大学生电子设计竞赛，
 *  偶数年（2022/2024）由各省自行组织省赛。
 *
 *  安全边界：本脚本只更新 official_problems.contest_type，
 *  不触碰 modules 表（模块数据由其他流程维护，含约 200 个抓取入库的模块）。
 *
 *  用法：
 *    干跑    npx tsx scripts/fix-contest-type.mts
 *    执行    npx tsx scripts/fix-contest-type.mts --apply
 */
import { db, ensureSchema, closeDb } from "../lib/db";
import { contestTypeByYear, CONTEST_LABEL } from "../lib/problem-taxonomy";

const APPLY = process.argv.includes("--apply");

async function main() {
  await ensureSchema();

  const rs = await db().execute({
    sql: `SELECT year, contest_type, COUNT(*) n FROM official_problems
          GROUP BY year, contest_type ORDER BY year DESC`,
    args: [],
  });

  const changes: { year: number; from: string; to: string; n: number }[] = [];
  for (const r of rs.rows as any[]) {
    const year = Number(r.year);
    const current = String(r.contest_type || "national");
    const correct = contestTypeByYear(year);
    if (current !== correct) {
      changes.push({ year, from: current, to: correct, n: Number(r.n) });
    }
  }

  if (!changes.length) {
    console.log("所有题目的赛事类型都已正确。");
    await closeDb();
    return;
  }

  console.log("需要修正的年份：\n");
  let total = 0;
  for (const c of changes) {
    const fromLabel = CONTEST_LABEL[c.from as never] || c.from;
    const toLabel = CONTEST_LABEL[c.to as never] || c.to;
    console.log(`  ${c.year} 年（${c.n} 题）：${String(fromLabel).split("（")[0]} → ${String(toLabel).split("（")[0]}`);
    total += c.n;
  }
  console.log(`\n合计 ${total} 题`);

  if (!APPLY) {
    console.log("\n（干跑模式。加 --apply 执行修正）");
    await closeDb();
    return;
  }

  // 只更新赛事类型这一列，其余字段与其他表均不动
  let updated = 0;
  for (const c of changes) {
    const r = await db().execute({
      sql: "UPDATE official_problems SET contest_type=?, updated_at=now() WHERE year=? RETURNING problem_id",
      args: [c.to, c.year],
    });
    updated += r.rows.length;
  }
  console.log(`\n已更新 ${updated} 题的赛事类型。`);

  const after = await db().execute({
    sql: `SELECT contest_type, COUNT(*) n FROM official_problems GROUP BY contest_type`,
    args: [],
  });
  console.log("\n当前分布：");
  for (const r of after.rows as any[]) {
    console.log(`  ${String(CONTEST_LABEL[String(r.contest_type) as never] || r.contest_type).split("（")[0]}: ${r.n}`);
  }
  await closeDb();
}

main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
