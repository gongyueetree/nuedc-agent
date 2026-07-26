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
import { claimTask, heartbeat, reclaimExpired, completeTask, failTask, reportWorkerAlive, unregisterWorker, bumpWorkerMetric, HEARTBEAT_MS, type ClaimedTask } from "../lib/task-queue";
import { db, ensureSchema, closeDb, dbDriver } from "../lib/db";
import type { AgentType, ProjectStage } from "../lib/types";

const WORKER_ID = process.env.WORKER_ID || `${hostname()}:${process.pid}`;
const HEAVY_SLOTS = Number(process.env.WORKER_HEAVY_SLOTS || 2);
const LIGHT_SLOTS = Number(process.env.WORKER_LIGHT_SLOTS || 6);
const POLL_MS = Number(process.env.WORKER_POLL_MS || 1500);
/** 是否允许 Worker 自行执行 DDL。生产默认关闭：
 *  迁移应由部署流程统一执行，避免多个 Worker 实例在生产库上并发跑 DDL，
 *  也避免 Worker 因权限过大而在 schema 不一致时做出意外变更。 */
const AUTO_MIGRATE = process.env.WORKER_AUTO_MIGRATE === "1";

let shuttingDown = false;
let inFlight = 0;
let consecutiveFailures = 0;
/** 当前是否因 schema 不兼容而待命（在 readiness 中暴露） */
let schemaWaiting = false;
const MAX_CONSECUTIVE_FAILURES = Number(process.env.WORKER_MAX_CONSECUTIVE_FAILURES || 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(...args: any[]) {
  console.log(`[${new Date().toISOString()}] [${WORKER_ID}]`, ...args);
}

async function executeOne(task: ClaimedTask): Promise<void> {
  inFlight++;
  const hb = setInterval(async () => {
    try {
      const alive = await heartbeat(task.task_id, WORKER_ID);
      if (!alive) log(`⚠ ${task.task_id} 租约已失效（可能已被回收），本次结果将被丢弃`);
    } catch (e: any) {
      // 不静默：心跳失败会导致租约过期、任务被重复执行，必须可观测
      await bumpWorkerMetric(WORKER_ID, "heartbeat_db_errors", String(e?.message || e));
      log(`⚠ 心跳写入失败：${String(e?.message || e).slice(0, 120)}`);
    }
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
    }).catch(async (e: any) => {
      await bumpWorkerMetric(WORKER_ID, "complete_task_db_errors", String(e?.message || e));
      return { rows: [] as any[] };
    });
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

    let outcome: string;
    try {
      outcome = await completeTask({
        taskId: task.task_id, workerId: WORKER_ID,
        ok: result.ok, canceled: wasCanceled, result, runId: result.run_id,
        errorCode: result.ok ? null : "AGENT_FAILED",
      });
    } catch (e: any) {
      await bumpWorkerMetric(WORKER_ID, "complete_task_db_errors", String(e?.message || e));
      log(`✗ ${task.task_id} 结果写入失败：${String(e?.message || e).slice(0, 120)}`);
      return;
    }
    if (outcome === "lease_lost") {
      log(`⚠ ${task.task_id} 租约已丢失，结果作废（任务已由其他 Worker 接管）`);
      return;
    }
    log(`${result.ok ? "✓" : "✗"} ${task.task_id} ${task.agent_type} (${task.task_type || "-"})${result.ok ? "" : " · " + (result.message || "").slice(0, 60)}`);
  } catch (e: any) {
    const msg = String(e?.message || e);
    // 网络/超时类错误可重试；业务错误不重试
    const retryable = /timeout|ECONN|fetch failed|socket|502|503|504/i.test(msg);
    try {
      const outcome = await failTask({
        taskId: task.task_id, workerId: WORKER_ID, message: msg,
        errorCode: retryable ? "TRANSIENT" : "EXECUTION_ERROR", retryable,
      });
      log(`✗ ${task.task_id} 异常 → ${outcome}: ${msg.slice(0, 100)}`);
    } catch (dbErr: any) {
      await bumpWorkerMetric(WORKER_ID, "fail_task_db_errors", String(dbErr?.message || dbErr));
      log(`✗ ${task.task_id} 失败状态写入异常：${String(dbErr?.message || dbErr).slice(0, 120)}`);
    }
  } finally {
    clearInterval(hb);
    inFlight--;
  }
}

const REQUIRED_TASK_COLUMNS = [
  "org_ref", "owner_ref", "project_id", "quota_ref", "quota_kind",
  "lease_expires_at", "worker_id", "heartbeat_at", "max_attempts",
];

/** 检查 agent_tasks 是否具备当前 Worker 版本所需的列 */
async function missingTaskColumns(): Promise<string[]> {
  const rs = await db().execute({
    sql: `SELECT column_name FROM information_schema.columns WHERE table_name='agent_tasks'`,
    args: [],
  });
  const have = new Set(rs.rows.map((r: any) => String(r.column_name)));
  return REQUIRED_TASK_COLUMNS.filter((c) => !have.has(c));
}

/** 等待数据库 schema 就绪。
 *  每轮重新执行迁移再检查 —— 若缺的列由新迁移提供，这里会自动补上；
 *  若迁移已跑过但列仍缺（历史上迁移内容被改过），则等待运维介入，
 *  期间保持进程存活，避免崩溃循环刷屏。 */
async function waitForSchema(): Promise<void> {
  const RECHECK_MS = 30_000;
  let warned = false;
  let rounds = 0;

  for (;;) {
    let missing: string[] = [];
    try {
      missing = await missingTaskColumns();
    } catch (e: any) {
      log(`⚠ schema 自检失败，${RECHECK_MS / 1000}s 后重试：${String(e?.message || e).slice(0, 140)}`);
      await sleep(RECHECK_MS);
      continue;
    }

    if (!missing.length) {
      if (warned) log("✓ 数据库 schema 已就绪，恢复正常工作");
      schemaWaiting = false;
      return;
    }

    if (!warned) {
      // 只在首次与每 10 轮打印，避免刷屏
      log(`❌ agent_tasks 缺少列：${missing.join(", ")}`);
      log("   数据库 schema 落后于当前 Worker 版本，暂不认领任务。");
      log("   修复方式：对同一个库执行 DATABASE_URL=... npm run db:init");
      log(AUTO_MIGRATE
        ? `   WORKER_AUTO_MIGRATE=1，本进程将每 ${RECHECK_MS / 1000}s 自行尝试迁移。`
        : `   WORKER_AUTO_MIGRATE 未开启，本进程只做周期检查、不执行 DDL；` +
          `每 ${RECHECK_MS / 1000}s 重查一次，迁移完成后自动恢复，无需重启容器。`);
      warned = true;
    } else if (++rounds % 10 === 0) {
      log(`仍在等待 schema 就绪（缺 ${missing.length} 列，已等待 ${Math.round(rounds * RECHECK_MS / 60000)} 分钟）`);
    }

    await bumpWorkerMetric(WORKER_ID, "schema_mismatch", `missing: ${missing.join(",")}`);
    schemaWaiting = true;

    if (AUTO_MIGRATE) {
      // 显式授权后才执行 DDL。force 绕过进程内缓存，
      // 跨实例仍由 advisory lock 保证同一时刻只有一个执行者
      try { await ensureSchema({ force: true }); } catch (e: any) {
        log(`  迁移重试失败：${String(e?.message || e).slice(0, 140)}`);
      }
    }
    await sleep(RECHECK_MS);
  }
}

/** 存活上报循环：让 /api/admin/readiness 能看到本 Worker。
 *  必须独立于任务心跳 —— 空闲时也要上报，否则会被误判为已下线。 */
async function aliveLoop() {
  const report = () => reportWorkerAlive({
    workerId: WORKER_ID, heavySlots: HEAVY_SLOTS, lightSlots: LIGHT_SLOTS,
    inFlight, driver: dbDriver(),
    schemaWaiting, autoMigrate: AUTO_MIGRATE,
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
      const { requeued, dead, batches } = await reclaimExpired();
      if (requeued || dead) {
        log(`回收：${requeued} 个重新入队，${dead} 个进入死信（${batches} 批）`);
      }
    } catch (e: any) {
      await bumpWorkerMetric(WORKER_ID, "reclaim_db_errors", String(e?.message || e));
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
      const msg = String(e?.message || e);
      // 缺列/缺表是 schema 问题，重启一百次也不会好 —— 立刻退出并说明原因，
      // 而不是重试 10 次后重启、再重试 10 次的无限循环
      if (e?.code === "42703" || e?.code === "42P01" || /does not exist/i.test(msg)) {
        // 运行中 schema 变更（如回滚了迁移）：回到待命等待，不退出、不刷屏
        log(`⚠ 认领失败：schema 不匹配（${msg.slice(0, 120)}），转入待命等待`);
        await bumpWorkerMetric(WORKER_ID, "schema_mismatch", msg);
        await waitForSchema();
        consecutiveFailures = 0;
        continue;
      }
      consecutiveFailures++;
      log(`认领异常(${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, msg.slice(0, 120));
      await bumpWorkerMetric(WORKER_ID, "claim_db_errors", msg);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log("❌ 连续认领失败次数过多，延迟后退出以便编排平台重启");
        shuttingDown = true;
        await sleep(Number(process.env.WORKER_FATAL_DELAY_MS || 15_000));
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
    // 延迟退出：立即退出会与编排平台的重启策略形成每秒一次的崩溃循环，
    // 既刷屏又拖慢真正的故障恢复。等待后退出，让重启节奏可控。
    await sleep(Number(process.env.WORKER_FATAL_DELAY_MS || 15_000));
    await closeDb();
    process.exit(1);
  }

  // schema 自检：等待 schema 就绪，而不是退出。
  // 立即 exit(1) 配合编排平台的重启策略会形成崩溃循环 ——
  // 每秒重启一次、日志刷屏、平台标记 Crashed，且问题本身并不会因重启好转。
  // 这里改为待命重试：定期重查，运维跑完迁移后自动恢复，无需人工重启容器。
  await waitForSchema();
  log(`启动：重型槽位 ${HEAVY_SLOTS} · 轻型槽位 ${LIGHT_SLOTS} · 轮询 ${POLL_MS}ms · 驱动 ${dbDriver()} · 自动迁移 ${AUTO_MIGRATE ? "开" : "关"}`);

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
