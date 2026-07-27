/** 抽查提取质量。批量跑之前先看几道题的实际结果，
 *  重点核对：数值单位是否与原文一致、有没有编造、基本/发挥是否分清。 */
import { db, ensureSchema, closeDb } from "../lib/db";

const N = Number(process.argv.find((a) => a.startsWith("--n="))?.split("=")[1] || 2);

async function main() {
  await ensureSchema();
  const vs = await db().execute({
    sql: `SELECT v.version_id, p.year, p.code, p.title, v.raw_text
          FROM problem_versions v JOIN official_problems p ON p.problem_id = v.problem_id
          WHERE EXISTS (SELECT 1 FROM problem_requirements r WHERE r.version_id = v.version_id)
          ORDER BY v.updated_at DESC NULLS LAST LIMIT ?`,
    args: [N],
  });

  for (const v of vs.rows as any[]) {
    console.log(`\n${"=".repeat(64)}`);
    console.log(`${v.year} ${v.code} · ${v.title}`);
    console.log("=".repeat(64));

    const rs = await db().execute({
      sql: `SELECT requirement_no, type, description, target, unit, tolerance, verification_method
            FROM problem_requirements WHERE version_id=? ORDER BY sort_order, requirement_no`,
      args: [v.version_id],
    });
    const byType: Record<string, number> = {};
    for (const r of rs.rows as any[]) byType[String(r.type)] = (byType[String(r.type)] || 0) + 1;
    console.log(`需求 ${rs.rows.length} 条 · ${Object.entries(byType).map(([k, n]) => `${k} ${n}`).join(" / ")}\n`);

    for (const r of rs.rows as any[]) {
      const num = r.target != null ? ` 【${r.target}${r.unit || ""}${r.tolerance ? " " + r.tolerance : ""}】` : "";
      console.log(`  [${r.type}] ${r.requirement_no}  ${String(r.description).slice(0, 62)}${num}`);
      // 数值若不在原文中出现，很可能是编造
      if (r.target != null && v.raw_text && !String(v.raw_text).includes(String(r.target))) {
        console.log(`      ⚠ 数值 ${r.target} 未在题面原文中出现，请核对`);
      }
    }

    const items = await db().execute({
      sql: "SELECT item, points FROM problem_scoring_items WHERE version_id=? ORDER BY sort_order",
      args: [v.version_id],
    });
    if (items.rows.length) {
      console.log(`\n评分项 ${items.rows.length} 项：`);
      for (const it of items.rows as any[]) console.log(`  ${it.item} — ${it.points ?? "?"} 分`);
    } else {
      const hasScoring = /评分|分值|满分/.test(String(v.raw_text || ""));
      console.log(`\n评分项 0 项${hasScoring ? "（题面提到评分但未提取到，需检查）" : "（题面本身无评分表）"}`);
    }
  }

  console.log(`\n${"=".repeat(64)}`);
  console.log("核对要点：数值单位是否与原文一致 / 有无编造 / basic 与 advanced 是否分清");
  await closeDb();
}

main().catch(async (e) => { console.error(e?.message || e); await closeDb(); process.exit(1); });
