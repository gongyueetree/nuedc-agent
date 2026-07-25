import { db, ensureSchema } from "./db";
import { commitQuota, refundQuota } from "./usage";

/** 任务队列：原子认领、租约续期、崩溃回收、死信。
 *  设计要点：
 *  - 认领用 FOR UPDATE SKIP LOCKED，多 Worker 并发不会抢到同一条
 *  - lease_expires_at 到期即视为 Worker 失联，任务重新入队（崩溃自愈）
 *  - 配额预占与任务绑定（quota_ref），终态时统一 commit/refund，不重复扣费 */

export const LEASE_MS = 90_000;        // 租约时长：超过即认定 Worker 失联
export const HEARTBEAT_MS = 30_000;    // 心跳间隔：每次续租

export interface ClaimedTask {
  task_id: string;
  agent_type: string;
  task_type: string | null;
  project_id: string | null;
  owner_ref: string | null;
  /** 组织标识：从 agent_tasks 列读取，绝不从 input 里取（客户端可伪造 input） */
  org_ref: string | null;
  input: string | null;
  tier: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  quota_ref: string | null;
  quota_kind: string | null;
}

/** 原子认领一个任务。concurrencyClass 为空时不限类型。 */
export async function claimTask(workerId: string, opts: { heavy?: boolean } = {}): Promise<ClaimedTask | null> {
  await ensureSchema();
  // queue_name 记录的是 concurrencyClass（light/heavy）
  const filter = opts.heavy === undefined ? "" : "AND queue_name = ?";
  const args: any[] = [];
  if (opts.heavy !== undefined) args.push(opts.heavy ? "heavy" : "light");

  const rs = await db().execute({
    sql: `UPDATE agent_tasks SET
            status='running', worker_id=?, started_at=COALESCE(started_at, now()),
            lease_expires_at = now() + interval '${LEASE_MS} milliseconds',
            heartbeat_at = now(), attempts = attempts + 1, updated_at = now()
          WHERE task_id = (
            SELECT task_id FROM agent_tasks
            WHERE status='queued' AND (scheduled_at IS NULL OR scheduled_at <= now()) ${filter}
            ORDER BY priority ASC, scheduled_at ASC NULLS FIRST, created_at ASC
            LIMIT 1 FOR UPDATE SKIP LOCKED
          )
          RETURNING task_id, agent_type, task_type, project_id, owner_ref, org_ref, input, tier,
                    priority, attempts, max_attempts, quota_ref, quota_kind`,
    args: [workerId, ...args],
  });
  return (rs.rows[0] as any) || null;
}

/** 心跳续租。返回 false 表示任务已被回收（Worker 应放弃继续写结果）。 */
export async function heartbeat(taskId: string, workerId: string): Promise<boolean> {
  const rs = await db().execute({
    sql: `UPDATE agent_tasks SET heartbeat_at = now(),
            lease_expires_at = now() + interval '${LEASE_MS} milliseconds', updated_at = now()
          WHERE task_id=? AND worker_id=? AND status='running' RETURNING task_id`,
    args: [taskId, workerId],
  }).catch(() => ({ rows: [] as any[] }));
  return rs.rows.length > 0;
}

/** 回收失联任务：租约过期的 running 任务重新入队；超过重试上限进死信。 */
export async function reclaimExpired(): Promise<{ requeued: number; dead: number }> {
  await ensureSchema();
  const requeue = await db().execute({
    sql: `UPDATE agent_tasks SET status='queued', worker_id=NULL, lease_expires_at=NULL,
            scheduled_at = now() + interval '5 seconds', updated_at=now()
          WHERE status='running' AND lease_expires_at < now()
            AND attempts < max_attempts
          RETURNING task_id`,
    args: [],
  }).catch(() => ({ rows: [] as any[] }));

  const dead = await db().execute({
    sql: `UPDATE agent_tasks SET status='dead', worker_id=NULL, lease_expires_at=NULL,
            dead_reason='Worker 失联且已达最大重试次数', completed_at=now(), updated_at=now()
          WHERE status='running' AND lease_expires_at < now() AND attempts >= max_attempts
          RETURNING task_id, owner_ref, quota_ref, quota_kind`,
    args: [],
  }).catch(() => ({ rows: [] as any[] }));

  // 死信任务返还未完成的配额预占
  for (const r of dead.rows as any[]) {
    if (r.quota_ref && r.owner_ref && r.quota_kind) {
      await refundQuota(String(r.owner_ref), String(r.quota_kind), String(r.quota_ref));
    }
  }
  return { requeued: requeue.rows.length, dead: dead.rows.length };
}

/** 任务完成：写结果 + 结算配额（幂等，重复调用无副作用） */
export async function completeTask(opts: {
  taskId: string; workerId: string; ok: boolean; canceled?: boolean;
  result: any; runId?: string | null; errorCode?: string | null;
}): Promise<void> {
  const usage = await db().execute({
    sql: `SELECT COALESCE(SUM(input_tokens),0) ti, COALESCE(SUM(output_tokens),0) to_,
                 COALESCE(SUM(estimated_cost),0) cost, COALESCE(SUM(fallback_used),0) fb,
                 MAX(provider) provider, MAX(model) model
          FROM llm_usage_events WHERE task_id=?`,
    args: [opts.taskId],
  }).catch(() => ({ rows: [{}] as any[] }));
  const u: any = usage.rows[0] || {};

  const status = opts.canceled ? "canceled" : opts.ok ? "ok" : "error";
  const claimed = await db().execute({
    sql: `UPDATE agent_tasks SET status=?, output=?, error=?, error_code=?, last_run_id=?,
            token_input=?, token_output=?, estimated_cost=?, fallback_count=?,
            model=COALESCE(?, model), provider_hint=COALESCE(?, provider_hint),
            lease_expires_at=NULL, completed_at=now(), updated_at=now()
          WHERE task_id=? AND status='running' AND worker_id=?
          RETURNING owner_ref, quota_ref, quota_kind`,
    args: [status, JSON.stringify(opts.result ?? null),
      opts.ok ? null : (opts.result?.message || "failed"), opts.errorCode ?? null, opts.runId ?? null,
      Number(u.ti || 0), Number(u.to_ || 0), Number(u.cost || 0), Number(u.fb || 0),
      u.model ? String(u.model) : null, u.provider ? String(u.provider) : null,
      opts.taskId, opts.workerId],
  }).catch(() => ({ rows: [] as any[] }));

  // 任务已被回收（租约过期）时不结算，避免重复扣费
  if (!claimed.rows.length) return;

  const row: any = claimed.rows[0];
  if (row.quota_ref && row.owner_ref && row.quota_kind) {
    // 成功才扣，失败/取消一律返还
    if (opts.ok && !opts.canceled) await commitQuota(String(row.quota_ref));
    else await refundQuota(String(row.owner_ref), String(row.quota_kind), String(row.quota_ref));
  }
}

/** 执行失败后按退避重新入队；超过上限进死信并返还配额 */
export async function failTask(opts: {
  taskId: string; workerId: string; message: string; errorCode?: string | null; retryable: boolean;
}): Promise<"requeued" | "dead"> {
  const rs = await db().execute({
    sql: "SELECT attempts, max_attempts, owner_ref, quota_ref, quota_kind FROM agent_tasks WHERE task_id=?",
    args: [opts.taskId],
  }).catch(() => ({ rows: [] as any[] }));
  const t: any = rs.rows[0] || {};
  const attempts = Number(t.attempts || 0);
  const max = Number(t.max_attempts || 3);

  if (opts.retryable && attempts < max) {
    // 指数退避 + 抖动
    const delaySec = Math.min(60, 2 ** attempts) + Math.floor(Math.random() * 5);
    await db().execute({
      sql: `UPDATE agent_tasks SET status='queued', worker_id=NULL, lease_expires_at=NULL,
              error=?, error_code=?, scheduled_at = now() + (? || ' seconds')::interval, updated_at=now()
            WHERE task_id=? AND worker_id=?`,
      args: [opts.message.slice(0, 500), opts.errorCode ?? null, String(delaySec), opts.taskId, opts.workerId],
    }).catch(() => {});
    return "requeued";
  }

  await db().execute({
    sql: `UPDATE agent_tasks SET status='dead', worker_id=NULL, lease_expires_at=NULL,
            error=?, error_code=?, dead_reason=?, completed_at=now(), updated_at=now()
          WHERE task_id=? AND worker_id=?`,
    args: [opts.message.slice(0, 500), opts.errorCode ?? null,
      opts.retryable ? `已达最大重试次数（${max}）` : "不可重试的错误", opts.taskId, opts.workerId],
  }).catch(() => {});

  if (t.quota_ref && t.owner_ref && t.quota_kind) {
      await refundQuota(String(t.owner_ref), String(t.quota_kind), String(t.quota_ref));
  }
  return "dead";
}

/** 队列概览 */
export async function queueStats() {
  await ensureSchema();
  const rs = await db().execute({
    sql: `SELECT status, priority, COUNT(*) n,
            COALESCE(AVG(EXTRACT(EPOCH FROM (COALESCE(started_at, now()) - created_at))), 0) avg_wait
          FROM agent_tasks WHERE created_at > now() - interval '2 hours'
          GROUP BY status, priority ORDER BY priority`,
    args: [],
  });
  return rs.rows.map((r: any) => ({
    status: String(r.status), priority: Number(r.priority),
    count: Number(r.n), avgWaitSec: Math.round(Number(r.avg_wait)),
  }));
}


/* ============ Worker 存活性 ============ */

/** Worker 存活判定窗口：超过此时长没有心跳即视为已下线 */
export const WORKER_LIVE_WINDOW_SEC = 60;

/** Worker 定期上报存活。与任务心跳不同：这是「进程还在」的证明，
 *  即使当前没有任务在跑也要上报，否则 readiness 会误判无可用 Worker。 */
export async function reportWorkerAlive(info: {
  workerId: string; heavySlots: number; lightSlots: number; inFlight: number; driver?: string;
}): Promise<void> {
  try {
    await ensureSchema();
    await db().execute({
      sql: `INSERT INTO worker_heartbeats (worker_id, started_at, last_seen, heavy_slots, light_slots, in_flight, driver)
            VALUES (?, now(), now(), ?, ?, ?, ?)
            ON CONFLICT (worker_id) DO UPDATE SET
              last_seen = now(), heavy_slots = EXCLUDED.heavy_slots,
              light_slots = EXCLUDED.light_slots, in_flight = EXCLUDED.in_flight,
              driver = EXCLUDED.driver`,
      args: [info.workerId, info.heavySlots, info.lightSlots, info.inFlight, info.driver ?? null],
    });
  } catch { /* 心跳失败不影响任务执行 */ }
}

/** Worker 退出时注销，让 readiness 立刻反映下线 */
export async function unregisterWorker(workerId: string): Promise<void> {
  await db().execute({ sql: "DELETE FROM worker_heartbeats WHERE worker_id=?", args: [workerId] }).catch(() => {});
}

export interface WorkerStatus {
  live: number;
  total: number;
  capacity: { heavy: number; light: number };
  inFlight: number;
  workers: { worker_id: string; last_seen: string; in_flight: number; stale: boolean }[];
}

/** 当前存活的 Worker 概览。live 是判断「任务能不能被消费」的唯一依据。 */
export async function workerStatus(): Promise<WorkerStatus> {
  await ensureSchema();
  const rs = await db().execute({
    sql: `SELECT worker_id, last_seen, heavy_slots, light_slots, in_flight,
            (last_seen < now() - interval '${WORKER_LIVE_WINDOW_SEC} seconds') AS stale
          FROM worker_heartbeats ORDER BY last_seen DESC`,
    args: [],
  });
  const rows = rs.rows as any[];
  const alive = rows.filter((r) => !r.stale);
  return {
    live: alive.length,
    total: rows.length,
    capacity: {
      heavy: alive.reduce((a, r) => a + Number(r.heavy_slots || 0), 0),
      light: alive.reduce((a, r) => a + Number(r.light_slots || 0), 0),
    },
    inFlight: alive.reduce((a, r) => a + Number(r.in_flight || 0), 0),
    workers: rows.map((r) => ({
      worker_id: String(r.worker_id),
      last_seen: String(r.last_seen),
      in_flight: Number(r.in_flight || 0),
      stale: !!r.stale,
    })),
  };
}
