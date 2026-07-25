/** 并发压测：模拟大量用户同时创建项目、采用题目、提交主方案任务并轮询。
 *
 *  默认使用 mock provider（零成本）。真实模型需显式加 --real。
 *  用法：
 *    BASE_URL=https://你的域名 npx tsx scripts/load-test.mts --users 100
 *    BASE_URL=... npx tsx scripts/load-test.mts --users 300 --ramp 30
 *    BASE_URL=... npx tsx scripts/load-test.mts --users 20 --real     # 谨慎：产生真实费用
 */

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const USERS = Number(arg("users", process.env.LOAD_USERS || "100"));
const RAMP_SEC = Number(arg("ramp", process.env.LOAD_RAMP_SEC || "10"));
const REAL = args.includes("--real");
const POLL_TIMEOUT_MS = Number(arg("timeout", process.env.LOAD_TIMEOUT_SEC || "300")) * 1000;
/** queue-only：只验证入队→去重→配额→查询链路，不等待模型执行完成。
 *  CI 用这个模式做几分钟内可完成的门禁冒烟。 */
const RAW_MODE = arg("mode", process.env.LOAD_MODE || "full");
/** mock-provider：端到端跑完（要求有 Worker 消费），与 full 等价但语义更明确
 *  queue-only：只验入队链路，不等执行 */
const MODE = (RAW_MODE === "mock-provider" ? "full" : RAW_MODE) as "full" | "queue-only";
const MODE_LABEL = RAW_MODE;
const OUT_FILE = arg("out", process.env.LOAD_OUT || "");

// 费用保护：full 模式会真正触发模型执行，需显式确认；
// queue-only 只验入队链路、不调用任何 Provider，无需此门槛。
if (!REAL && MODE !== "queue-only" && !process.env.ALLOW_MOCK_ASSUMED) {
  console.log("⚠ 默认按 mock provider 压测。请确认服务端已设 ENABLE_MOCK_PROVIDER=1，否则会产生真实模型费用。");
  console.log("  确认无误请加环境变量 ALLOW_MOCK_ASSUMED=1 重跑；使用真实模型请加 --real。\n");
  process.exit(1);
}

interface Sample {
  ok: boolean;
  createMs: number;
  adoptMs: number;
  queueWaitMs: number;
  totalMs: number;
  status?: string;
  errorCode?: string;
  http429: boolean;
  provider?: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  fallback: boolean;
  retries: number;
  dbError: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function oneUser(i: number): Promise<Sample> {
  const s: Sample = {
    ok: false, createMs: 0, adoptMs: 0, queueWaitMs: 0, totalMs: 0,
    http429: false, tokensIn: 0, tokensOut: 0, cost: 0, fallback: false, retries: 0, dbError: false,
  };
  const t0 = Date.now();
  let cookie = "";

  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(BASE + path, {
      ...init,
      headers: { "content-type": "application/json", cookie, ...(init.headers || {}) },
    });
    const setC = res.headers.get("set-cookie");
    if (setC) cookie = setC.split(";")[0];
    let data: any = null;
    try { data = await res.json(); } catch { /* 非 JSON */ }
    return { status: res.status, data };
  };

  try {
    // 1. 创建项目（匿名身份自动签发）
    const c0 = Date.now();
    const proj = await call("/api/projects", { method: "POST", body: JSON.stringify({ name: `压测项目 ${i}` }) });
    s.createMs = Date.now() - c0;
    if (proj.status === 429) s.http429 = true;
    if (!proj.data?.project_id) {
      s.errorCode = `CREATE_${proj.status}`;
      if (proj.status >= 500) s.dbError = true;
      s.totalMs = Date.now() - t0;
      return s;
    }
    const pid = proj.data.project_id;

    // 2. 写入需求（模拟采用官方题目后的状态；避免压测依赖题库数据）
    const a0 = Date.now();
    await call(`/api/projects/${pid}/artifacts`, {
      method: "POST",
      body: JSON.stringify({
        type: "requirements",
        content: {
          requirements: Array.from({ length: 8 }, (_, k) => ({
            id: `REQ-${String(k + 1).padStart(3, "0")}`,
            type: "performance", description: `压测需求 ${k + 1}：输出电压可调并显示`,
            target: 5, unit: "V", tolerance: "±1%",
            priority: k < 5 ? "mandatory" : "bonus",
            source: "压测", verification_method: "measurement", status: "CONFIRMED",
          })),
          scoring_items: [],
        },
      }),
    });
    // 推进到需求已解析阶段 —— 否则 solution_architect 会被状态机门禁拒绝
    await call(`/api/projects/${pid}`, {
      method: "PATCH",
      body: JSON.stringify({ stage: "REQUIREMENTS_PARSED" }),
    });
    s.adoptMs = Date.now() - a0;

    // 3. 提交主方案任务（重型任务，走队列）
    const task = await call("/api/agent-tasks", {
      method: "POST",
      body: JSON.stringify({
        agent: "solution_architect",
        project_id: pid,
        input: {
          requirements: {
            requirements: Array.from({ length: 4 }, (_, k) => ({
              id: `REQ-${String(k + 1).padStart(3, "0")}`,
              type: "performance", description: `压测需求 ${k + 1}`,
              target: 5, unit: "V", tolerance: "±1%",
              priority: "mandatory", source: "压测",
              verification_method: "measurement", status: "CONFIRMED",
            })),
            scoring_items: [],
          },
        },
      }),
    });
    if (task.status === 429) { s.http429 = true; s.errorCode = "USER_CONCURRENCY"; s.totalMs = Date.now() - t0; return s; }
    if (task.status === 503) { s.errorCode = "SYSTEM_MODE"; s.status = "degraded"; s.totalMs = Date.now() - t0; return s; }
    if (!task.data?.task_id) { s.errorCode = `TASK_${task.status}`; s.totalMs = Date.now() - t0; return s; }

    const taskId = task.data.task_id;

    // queue-only：确认任务已正确入队即算成功，不等待 Worker 执行
    if (MODE === "queue-only") {
      const st = await call(`/api/agent-tasks/${taskId}`);
      s.status = st.data?.status || "unknown";
      s.ok = ["queued", "running", "ok"].includes(String(s.status));
      s.queueWaitMs = 0;
      if (!s.ok) s.errorCode = `QUEUE_${s.status}`;
      // 幂等校验：相同输入再提交一次必须被去重
      const again = await call("/api/agent-tasks", {
        method: "POST",
        body: JSON.stringify({
          agent: "solution_architect", project_id: pid,
          input: { requirements: { requirements: [{ id: "REQ-001", description: `压测需求 1`, target: 5, unit: "V", tolerance: "±1%", priority: "mandatory", source: "压测", verification_method: "measurement", status: "CONFIRMED" }] } },
        }),
      });
      if (again.data?.task_id && again.data.task_id !== taskId && !again.data?.deduped) {
        s.ok = false; s.errorCode = "DEDUP_FAILED";
      }
      s.totalMs = Date.now() - t0;
      return s;
    }

    // 4. 点火 + 轮询（full 模式）
    fetch(`${BASE}/api/agent-tasks/${taskId}/execute`, { method: "POST", headers: { cookie } }).catch(() => {});
    const qStart = Date.now();
    let queueLeftAt = 0;
    while (Date.now() - qStart < POLL_TIMEOUT_MS) {
      await sleep(2000);
      const st = await call(`/api/agent-tasks/${taskId}`);
      if (st.status === 429) s.http429 = true;
      const d = st.data;
      if (!d) continue;
      if (d.status === "running" && !queueLeftAt) queueLeftAt = Date.now();
      if (["ok", "error", "canceled", "dead"].includes(d.status)) {
        s.status = d.status;
        s.ok = d.status === "ok";
        s.queueWaitMs = (queueLeftAt || Date.now()) - qStart;
        s.tokensIn = d.tokens?.input || 0;
        s.tokensOut = d.tokens?.output || 0;
        s.cost = d.cost || 0;
        s.fallback = !!d.fallback_used;
        s.provider = d.model || d.result?.provider;
        if (!s.ok) s.errorCode = d.error?.slice(0, 70) || d.status;
        break;
      }
    }
    if (!s.status) { s.status = "timeout"; s.errorCode = "POLL_TIMEOUT"; }
  } catch (e: any) {
    s.errorCode = `EXCEPTION_${String(e?.message || e).slice(0, 30)}`;
  }
  s.totalMs = Date.now() - t0;
  return s;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function preflight(): Promise<boolean> {
  // 用一次极小的探测请求确认服务端 Provider —— 避免"以为在 mock，其实在烧真钱"
  try {
    const res = await fetch(`${BASE}/api/admin/system-mode`, { headers: { "content-type": "application/json" } });
    const mode = await res.json().catch(() => null);
    console.log(`服务端模式：${mode?.label || mode?.mode || "未知"} · 当前队列 ${mode?.queue_length ?? "?"}`);
  } catch {
    console.log("⚠ 无法连接服务端，请检查 BASE_URL");
    return false;
  }
  if (REAL) return true;
  // queue-only 不触发模型执行，无需 mock 校验
  if (MODE === "queue-only") { console.log("✓ queue-only 模式：只验队列链路，不调用模型\n"); return true; }

  // 直接询问服务端当前选路结果（公开只读，不消耗 token、不依赖跑任务）
  try {
    const res = await fetch(`${BASE}/api/routing-preview`);
    if (res.ok) {
      const d = await res.json();
      if (d.mock_enabled) {
        console.log(`✓ 预检通过：服务端启用 mock provider（首选 ${d.primary_candidate || "mock"}）\n`);
        return true;
      }
      console.log(`\n⛔ 服务端未启用 mock，实际首选 provider = "${d.primary_candidate || "未知"}"`);
      console.log("   压测会产生真实模型费用。请在部署环境设置 ENABLE_MOCK_PROVIDER=1 并【重新部署】后再跑；");
      console.log("   若确认要用真实模型压测，请显式加 --real 参数。\n");
      return false;
    }
  } catch { /* 端点不存在时落到下面的兜底判断 */ }

  // 旧版本部署没有该端点时，无法确认 provider —— 保守中止，避免误烧真实费用
  console.log("\n⚠ 服务端无 /api/routing-preview（可能是旧版本部署），无法确认是否为 mock。");
  console.log("   请先部署最新代码；若确认要用真实模型压测，请显式加 --real 参数。\n");
  return false;
}

async function main() {
  console.log(`压测目标：${BASE}`);
  console.log(`并发用户：${USERS} · 爬坡：${RAMP_SEC}s · 模式：${MODE_LABEL}${REAL ? "（⚠ 真实模型）" : ""}\n`);

  if (!(await preflight())) process.exit(2);

  const t0 = Date.now();
  const tasks: Promise<Sample>[] = [];
  for (let i = 0; i < USERS; i++) {
    // 爬坡启动，避免瞬时打爆连接池
    const delay = (RAMP_SEC * 1000 * i) / Math.max(USERS, 1);
    tasks.push(sleep(delay).then(() => oneUser(i)));
  }
  const results = await Promise.all(tasks);
  const wall = (Date.now() - t0) / 1000;

  const ok = results.filter((r) => r.ok);
  const totals = results.map((r) => r.totalMs).sort((a, b) => a - b);
  const queues = results.map((r) => r.queueWaitMs).filter((x) => x > 0).sort((a, b) => a - b);
  const byProvider: Record<string, number> = {};
  const byError: Record<string, number> = {};
  for (const r of results) {
    if (r.provider) byProvider[r.provider] = (byProvider[r.provider] || 0) + 1;
    if (r.errorCode) byError[r.errorCode] = (byError[r.errorCode] || 0) + 1;
  }
  const totalCost = results.reduce((a, r) => a + r.cost, 0);
  const totalIn = results.reduce((a, r) => a + r.tokensIn, 0);
  const totalOut = results.reduce((a, r) => a + r.tokensOut, 0);

  console.log("========== 结果 ==========");
  console.log(`总耗时：        ${wall.toFixed(1)}s`);
  console.log(`成功率：        ${((ok.length / USERS) * 100).toFixed(1)}%  (${ok.length}/${USERS})`);
  console.log(`HTTP 429：      ${results.filter((r) => r.http429).length}`);
  console.log(`数据库错误：    ${results.filter((r) => r.dbError).length}`);
  console.log(`降级拒绝：      ${results.filter((r) => r.status === "degraded").length}`);
  console.log(`超时：          ${results.filter((r) => r.errorCode === "POLL_TIMEOUT").length}`);
  console.log(`容灾切换：      ${results.filter((r) => r.fallback).length}`);
  console.log("");
  console.log(`平均排队：      ${queues.length ? (queues.reduce((a, b) => a + b, 0) / queues.length / 1000).toFixed(1) : 0}s`);
  console.log(`P50 完成：      ${(pct(totals, 0.5) / 1000).toFixed(1)}s`);
  console.log(`P95 完成：      ${(pct(totals, 0.95) / 1000).toFixed(1)}s`);
  console.log(`P99 完成：      ${(pct(totals, 0.99) / 1000).toFixed(1)}s`);
  console.log("");
  console.log(`总 token：      输入 ${totalIn} / 输出 ${totalOut}`);
  console.log(`单用户 token：  输入 ${Math.round(totalIn / Math.max(ok.length, 1))} / 输出 ${Math.round(totalOut / Math.max(ok.length, 1))}`);
  console.log(`总成本：        $${totalCost.toFixed(4)}`);
  console.log(`单用户成本：    $${(totalCost / Math.max(ok.length, 1)).toFixed(5)}`);
  console.log("");
  console.log("Provider 分布：", Object.keys(byProvider).length ? byProvider : "（无）");
  if (Object.keys(byError).length) console.log("错误分布：    ", byError);

  // 判定：queue-only 只看入队成功率与响应速度；full 模式还要看端到端 P95
  const p95s = pct(totals, 0.95) / 1000;
  const passRate = ok.length / USERS;
  const p95Limit = MODE === "queue-only" ? 30 : 180;
  const pass = passRate >= 0.9 && p95s <= p95Limit;

  if (OUT_FILE) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify({
      mode: MODE_LABEL, users: USERS, wall_seconds: wall,
      success_rate: passRate, successes: ok.length,
      http_429: results.filter((r) => r.http429).length,
      db_errors: results.filter((r) => r.dbError).length,
      degraded: results.filter((r) => r.status === "degraded").length,
      timeouts: results.filter((r) => r.errorCode === "POLL_TIMEOUT").length,
      fallbacks: results.filter((r) => r.fallback).length,
      p50_seconds: pct(totals, 0.5) / 1000,
      p95_seconds: p95s,
      p99_seconds: pct(totals, 0.99) / 1000,
      avg_queue_seconds: queues.length ? queues.reduce((a, b) => a + b, 0) / queues.length / 1000 : 0,
      total_input_tokens: totalIn, total_output_tokens: totalOut,
      total_cost_usd: totalCost,
      provider_distribution: byProvider,
      error_distribution: byError,
      thresholds: { min_success_rate: 0.9, max_p95_seconds: p95Limit },
      pass,
    }, null, 2));
    console.log(`\n结果已写入 ${OUT_FILE}`);
  }

  console.log(`\n判定：${pass ? "✓ 达标" : "✗ 未达标"}（成功率 ≥90% 且 P95 ≤${p95Limit}s，模式 ${MODE_LABEL}）`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
