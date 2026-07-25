/** 后台 Worker：常驻进程消费 agent_tasks 队列。
 *
 *  部署方式（本项目选定常驻模式）：
 *    npm run worker                      # 本地或服务器直接跑
 *    pm2 start npm --name nuedc-worker -- run worker
 *    docker run ... npm run worker       # 容器常驻
 *
 *  环境变量：
 *    DATABASE_URL            必填，与 Web 同一个库
 *    WORKER_ID               可选，默认 hostname:pid
 *    WORKER_HEAVY_SLOTS      重型任务并发（默认 2）
 *    WORKER_LIGHT_SLOTS      轻型任务并发（默认 6）
 *    WORKER_POLL_MS          空闲轮询间隔（默认 1500）
 *
 *  可靠性：租约 90 秒、心跳 30 秒续租；进程崩溃后租约到期，
 *  任务由任意 Worker 的回收循环重新入队，不会永久卡死也不会重复扣费。 */

import { hostname } from "node:os";
import "../lib/agents/index";
import { runAgent } from "../lib/agents/base";
import { claimTask, heartbeat, reclaimExpired, completeTask, failTask, reportWorkerAlive, unregisterWorker, HEARTBEAT_MS, type ClaimedTask } from "../lib/task-queue";
import { db, ensureSchema, closeDb, dbDriver } from "../lib/db";
import type { AgentType, ProjectStage } from "../lib/types";

const WORKER_ID = process.env.WORKER_ID || `${hostname()}:${process.pid}`;
const HEAVY_SLOTS = Number(process.env.WORKER_HEAVY_SLOTS || 2);
const LIGHT_SLOTS = Number(process.env.WORKER_LIGHT_SLOTS || 6);
const POLL_MS = Number(process.env.WORKER_POLL_MS || 1500);

let shuttingDown = false;
let inFlight = 0;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = Number(process.env.WORKER_MAX_CONSECUTIVE_FAILURES || 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(...args: any[]) {
  console.log(`[${new Date().toISOString()}] [${WORKER_ID}]`, ...args);
}

async function executeOne(task: ClaimedTask): Promise<void> {
  inFlight++;
  const hb = setInterval(async () => {
    const alive = await heartbeat(task.task_id, WORKER_ID);
    if (!alive) log(`⚠ ${task.task_id} 租约已失效（可能已被回收），本次结果将被丢弃`);
  }, HEARTBEAT_MS);

  try {
    const input = task.input ? JSON.parse(task.input) : {};
    let stage: ProjectStage = "PREPARATION";
    if (task.project_id) {
      const rs = await db().execute({ sql: "SELECT stage FROM projects WHERE project_id=?", args: [task.project_id] });
      if (rs.rows.length) stage = String(rs.rows[0].stage) as ProjectStage;
    }

    // 执行期间被请求取消 → 结果作废（LLM 调用无法中途打断，只能事后判定）
    const cancelCheck = await db().execute({
      sql: "SELECT cancel_requested FROM agent_tasks WHERE task_id=?", args: [task.task_id],
    }).catch(() => ({ rows: [] as any[] }));
    if (Number((cancelCheck.rows[0] as any)?.cancel_requested || 0) === 1) {
      await completeTask({ taskId: task.task_id, workerId: WORKER_ID, ok: false, canceled: true, result: null });
      log(`✋ ${task.task_id} 已取消`);
      return;
    }

    const result = await runAgent(task.agent_type as AgentType, input, {
      projectId: task.project_id,
      stage,
      tier: task.tier as any,
      owner: task.owner_ref,
      // 组织来自任务列，不从 input 读 —— 保证异步执行的可见范围与提交者一致
      org: task.org_ref,
      taskId: task.task_id,
    });

    const canceled = await db().execute({
      sql: "SELECT cancel_requested FROM agent_tasks WHERE task_id=?", args: [task.task_id],
    }).catch(() => ({ rows: [] as any[] }));
    const wasCanceled = Number((canceled.rows[0] as any)?.cancel_requested || 0) === 1;

    await completeTask({
      taskId: task.task_id, workerId: WORKER_ID,
      ok: result.ok, canceled: wasCanceled, result, runId: result.run_id,
      errorCode: result.ok ? null : "AGENT_FAILED",
    });
    log(`${result.ok ? "✓" : "✗"} ${task.task_id} ${task.agent_type} (${task.task_type || "-"})${result.ok ? "" : " · " + (result.message || "").slice(0, 60)}`);
  } catch (e: any) {
    const msg = String(e?.message || e);
    // 网络/超时类错误可重试；业务错误不重试
    const retryable = /timeout|ECONN|fetch failed|socket|502|503|504/i.test(msg);
    const outcome = await failTask({
      taskId: task.task_id, workerId: WORKER_ID, message: msg,
      errorCode: retryable ? "TRANSIENT" : "EXECUTION_ERROR", retryable,
    });
    log(`✗ ${task.task_id} 异常 → ${outcome}: ${msg.slice(0, 100)}`);
  } finally {
    clearInterval(hb);
    inFlight--;
  }
}

/** 存活上报循环：让 /api/admin/readiness 能看到本 Worker。
 *  必须独立于任务心跳 —— 空闲时也要上报，否则会被误判为已下线。 */
async function aliveLoop() {
  const report = () => reportWorkerAlive({
    workerId: WORKER_ID, heavySlots: HEAVY_SLOTS, lightSlots: LIGHT_SLOTS,
    inFlight, driver: dbDriver(),
  });
  await report();   // 启动即上报一次，缩短 CI 等待
  while (!shuttingDown) {
    await sleep(15_000);
    if (!shuttingDown) await report();
  }
}

/** 回收循环：处理其他 Worker 崩溃遗留的任务 */
async function reclaimLoop() {
  while (!shuttingDown) {
    try {
      const { requeued, dead } = await reclaimExpired();
      if (requeued || dead) log(`回收：${requeued} 个重新入队，${dead} 个进入死信`);
    } catch (e: any) {
      log("回收循环异常:", String(e?.message || e).slice(0, 120));
    }
    await sleep(30_000);
  }
}

/** 消费循环：按并发槽位认领任务 */
async function consumeLoop(heavy: boolean, slots: number) {
  const running = new Set<Promise<void>>();
  while (!shuttingDown) {
    if (running.size >= slots) {
      await Promise.race(running);
      continue;
    }
    let task: ClaimedTask | null = null;
    try {
      task = await claimTask(WORKER_ID, { heavy });
      consecutiveFailures = 0;
    } catch (e: any) {
      consecutiveFailures++;
      log(`认领异常(${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, String(e?.message || e).slice(0, 120));
      // 数据库持续不可用时退出，交给编排平台重启，避免僵死进程占着租约
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log("❌ 连续认领失败次数过多，退出以便编排平台重启");
        shuttingDown = true;
        await closeDb();
        process.exit(1);
      }
      await sleep(Math.min(30_000, 3000 * consecutiveFailures));
      continue;
    }
    if (!task) { await sleep(POLL_MS); continue; }

    const p = executeOne(task).finally(() => running.delete(p));
    running.add(p);
  }
  await Promise.allSettled([...running]);
}

async function main() {
  // 启动自检：数据库不可达时立刻退出并给出可读原因，
  // 而不是卡在报错循环里 —— 那会让容器僵死、SIGTERM 也叫不动
  try {
    await ensureSchema();
  } catch (e: any) {
    log(`❌ 数据库不可用，Worker 无法启动：${String(e?.message || e).slice(0, 200)}`);
    log("   请检查 DATABASE_URL 是否正确、数据库是否可从本容器访问。");
    await closeDb();
    process.exit(1);
  }
  log(`启动：重型槽位 ${HEAVY_SLOTS} · 轻型槽位 ${LIGHT_SLOTS} · 轮询 ${POLL_MS}ms · 驱动 ${dbDriver()}`);

  const shutdown = async (sig: string) => {
    if (shuttingDown) { log(`再次收到 ${sig}，强制退出`); process.exit(130); }
    shuttingDown = true;
    const graceMs = Number(process.env.WORKER_SHUTDOWN_GRACE_MS || 30_000);
    log(`收到 ${sig}，停止认领新任务，等待 ${inFlight} 个在途任务完成（最多 ${graceMs / 1000}s）…`);
    // 兜底：无论如何都要在宽限期后退出，避免容器停不掉
    const hardExit = setTimeout(() => { log("⚠ 宽限期已到，强制退出"); process.exit(0); }, graceMs + 5000);
    hardExit.unref?.();
    const deadline = Date.now() + graceMs;
    while (inFlight > 0 && Date.now() < deadline) await sleep(500);
    // 未完成的任务释放租约，让其他 Worker 立刻接管
    await db().execute({
      sql: `UPDATE agent_tasks SET status='queued', worker_id=NULL, lease_expires_at=NULL, updated_at=now()
            WHERE worker_id=? AND status='running'`,
      args: [WORKER_ID],
    }).catch(() => {});
    await unregisterWorker(WORKER_ID);   // 注销，让 readiness 立刻反映下线
    await closeDb();      // 释放连接池，避免进程挂住
    log("已优雅退出");
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await Promise.all([
    consumeLoop(true, HEAVY_SLOTS),
    consumeLoop(false, LIGHT_SLOTS),
    reclaimLoop(),
    aliveLoop(),
  ]);
}

// 冒烟测试用：只验证模块能被完整加载，不进入主循环
if (process.env.WORKER_SMOKE_IMPORT_ONLY === "1") {
  console.log("[smoke] Worker 模块加载成功");
} else {
  main().catch((e) => { console.error("Worker 致命错误:", e); process.exit(1); });
}
