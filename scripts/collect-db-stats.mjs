#!/usr/bin/env node
/** 压测后收集数据库侧指标，用于定位瓶颈。
 *  压测报告只能说明"慢"，这里回答"慢在哪"：
 *  连接数是否打满、任务是否堆积、有没有长事务。 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=") || "true"];
  }),
);
const MODE = args.mode || "unknown";
const OUT = args.out || "";

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("未配置 DATABASE_URL，跳过数据库统计");
  process.exit(0);
}

let pg;
try {
  pg = await import("pg");
} catch {
  console.log("未安装 pg，跳过数据库统计");
  process.exit(0);
}

const pool = new pg.default.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 8000 });
const lines = [`# 数据库统计 · 模式 ${MODE} · ${new Date().toISOString()}`, ""];

async function section(title, sql) {
  lines.push(`## ${title}`);
  try {
    const { rows } = await pool.query(sql);
    if (!rows.length) { lines.push("(无数据)", ""); return; }
    const keys = Object.keys(rows[0]);
    lines.push(keys.join(" | "));
    lines.push(keys.map(() => "---").join(" | "));
    for (const r of rows.slice(0, 40)) lines.push(keys.map((k) => String(r[k] ?? "")).join(" | "));
    lines.push("");
  } catch (e) {
    lines.push(`查询失败：${String(e?.message || e).slice(0, 160)}`, "");
  }
}

await section("任务状态分布", `
  SELECT status, COUNT(*) AS n,
         ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(completed_at, now()) - created_at)))::numeric, 2) AS avg_total_sec,
         ROUND(AVG(EXTRACT(EPOCH FROM (started_at - created_at)))::numeric, 2) AS avg_wait_sec
  FROM agent_tasks GROUP BY status ORDER BY n DESC`);

await section("按优先级排队深度", `
  SELECT priority, status, COUNT(*) AS n
  FROM agent_tasks WHERE status IN ('queued','running')
  GROUP BY priority, status ORDER BY priority`);

await section("Worker 心跳", `
  SELECT worker_id, in_flight, heavy_slots, light_slots,
         ROUND(EXTRACT(EPOCH FROM (now() - last_seen))::numeric, 1) AS last_seen_ago_sec
  FROM worker_heartbeats ORDER BY last_seen DESC`);

await section("模型调用统计", `
  SELECT provider, status, COUNT(*) AS n,
         ROUND(AVG(latency_ms)::numeric, 0) AS avg_ms,
         ROUND(SUM(estimated_cost)::numeric, 6) AS cost
  FROM llm_usage_events GROUP BY provider, status ORDER BY n DESC`);

await section("数据库连接", `
  SELECT state, COUNT(*) AS n FROM pg_stat_activity
  WHERE datname = current_database() GROUP BY state ORDER BY n DESC`);

await section("表大小", `
  SELECT relname AS table_name, n_live_tup AS rows
  FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 15`);

await pool.end().catch(() => {});

const text = lines.join("\n");
console.log(text);
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`\n已写入 ${OUT}`);
}
