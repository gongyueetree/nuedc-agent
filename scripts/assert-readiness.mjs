#!/usr/bin/env node
/** 压测前置就绪检查。
 *
 *  不同压测模式对环境的要求不同：
 *    queue-only    只需 Web + 数据库（不启动 Worker，任务留在队列里）
 *    mock-provider 必须有 Live Worker，否则任务永远排队、压测毫无意义
 *    report-only   只记录快照，不做断言（压测后收集用）
 *
 *  用法：
 *    node scripts/assert-readiness.mjs --mode=mock-provider \
 *      --url=http://127.0.0.1:3000/api/admin/readiness --out=reports/readiness.json
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=") || "true"];
  }),
);

const MODE = args.mode || "report-only";
const URL_ = args.url || "http://127.0.0.1:3000/api/admin/readiness";
const OUT = args.out || "";
const KEY = process.env.ADMIN_API_KEY || "";
const RETRIES = Number(args.retries || 10);

async function fetchReadiness() {
  let last = null;
  for (let i = 0; i < RETRIES; i++) {
    try {
      const res = await fetch(URL_, { headers: KEY ? { "X-Api-Key": KEY } : {} });
      const body = await res.json().catch(() => null);
      if (res.ok && body) return body;
      last = `HTTP ${res.status} ${JSON.stringify(body)?.slice(0, 200)}`;
    } catch (e) {
      last = String(e?.message || e);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`无法获取就绪信息：${last}`);
}

function check(name, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(22)} ${detail}`);
  return ok;
}

const data = await fetchReadiness();

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(data, null, 2));
}

console.log(`\n就绪检查 · 模式 ${MODE}`);

if (MODE === "report-only") {
  console.log(JSON.stringify({
    workers: data.workers?.live, queue: data.queue, mode: data.system_mode,
  }));
  console.log("（仅记录快照，不做断言）");
  process.exit(0);
}

const results = [];
// 任一子系统查询失败即视为未就绪（fail-closed）
results.push(check("整体就绪", data.ok === true,
  data.ok ? "所有子系统正常" : "存在查询失败的子系统"));

results.push(check("Worker 查询", data.workers?.ok !== false,
  data.workers?.ok === false ? `失败：${data.workers.error}` : "正常"));

results.push(check("队列查询", data.queue?.ok !== false,
  data.queue?.ok === false ? `失败：${data.queue.error}` : "正常"));

results.push(check("数据库连通", data.database?.ok === true,
  data.database?.ok ? `驱动 ${data.database.driver} · ${data.database.migrations_applied} 个迁移` : data.database?.error || "不可用"));

results.push(check("模型 Provider", (data.providers?.count || 0) > 0,
  `${data.providers?.count || 0} 家已配置${data.providers?.mock_enabled ? "（mock 已启用）" : ""}`));

// 压测绝不能烧真钱
results.push(check("mock 模式", data.providers?.mock_enabled === true,
  data.providers?.mock_enabled ? "已启用" : "未启用 —— 压测会产生真实费用"));

results.push(check("系统模式", data.system_mode === "NORMAL",
  `${data.system_mode}${data.system_mode !== "NORMAL" ? "（降级模式下任务会被拒绝）" : ""}`));

if (MODE === "mock-provider") {
  // 端到端压测必须有 Worker 消费任务，否则测的只是入队
  const live = data.workers?.live || 0;
  results.push(check("Live Worker", live >= 1,
    live >= 1 ? `${live} 个存活 · 容量 heavy ${data.workers.capacity?.heavy}/light ${data.workers.capacity?.light}`
              : "没有存活 Worker —— 任务会一直排队，压测无意义"));
}

if (MODE === "queue-only") {
  // 队列压测反而要求没有 Worker，否则任务会被消费掉，队列深度指标失真
  const live = data.workers?.live || 0;
  results.push(check("无 Worker 干扰", live === 0,
    live === 0 ? "无存活 Worker（符合 queue-only 预期）"
               : `检测到 ${live} 个 Worker，会消费掉任务导致队列指标失真`));
}

const failed = results.filter((r) => !r).length;
if (failed) {
  console.error(`\n❌ ${failed} 项未就绪，终止压测`);
  process.exit(1);
}
console.log("\n✓ 环境就绪");
