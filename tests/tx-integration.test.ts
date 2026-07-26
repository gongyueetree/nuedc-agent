import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

/** 真实 PostgreSQL 集成测试：验证任务状态转换与配额结算的事务原子性。
 *
 *  表名必须带 tx_test_ 前缀：CI 中本测试与 Worker 冒烟共用同一个数据库，
 *  若用生产表名，CREATE TABLE IF NOT EXISTS 会用简化结构占住表，
 *  导致后续 ensureSchema 跳过建表、迁移引用不存在的列而失败。
 *
 *  这些场景在 mock 或内存数据库上验证不了 —— 需要真的 BEGIN/COMMIT/ROLLBACK：
 *  - 租约丢失后不得结算
 *  - 事务中途失败必须同时回滚任务状态与配额状态
 *  - 并发终态转换只能成功一次
 *
 *  运行方式：
 *    TEST_DATABASE_URL=postgresql://ci:ci@127.0.0.1:5432/nuedc_test npx vitest run tests/tx-integration.test.ts
 *  CI 中由 postgres:16 service 提供。未配置时整组跳过（不静默通过，会打印提示）。 */

const TEST_URL = process.env.TEST_DATABASE_URL || "";
const hasDb = !!TEST_URL;

let pool: any;

async function q(sql: string, args: any[] = []) {
  const r = await pool.query(sql, args);
  return r.rows;
}

/** 独立实现被测的事务语义，直接对真实数据库执行。
 *  与 lib/task-queue.ts 的 SQL 保持一致；这里显式控制事务边界以便注入故障。 */
async function settleInTransaction(opts: {
  taskId: string; workerId: string; ok: boolean;
  failAfterTaskUpdate?: boolean; failAfterQuotaOp?: boolean;
}): Promise<"settled" | "lease_lost"> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    const upd = await c.query(
      `UPDATE tx_test_agent_tasks SET status=$1, completed_at=now(), lease_expires_at=NULL
       WHERE task_id=$2 AND status='running' AND worker_id=$3
       RETURNING owner_ref, quota_ref, quota_kind`,
      [opts.ok ? "ok" : "dead", opts.taskId, opts.workerId],
    );

    if (!upd.rows.length) {
      await c.query("ROLLBACK");
      return "lease_lost";
    }

    // 注入点 1：任务已更新，配额尚未结算
    if (opts.failAfterTaskUpdate) throw new Error("INJECTED_AFTER_TASK_UPDATE");

    const row = upd.rows[0];
    if (row.quota_ref) {
      if (opts.ok) {
        await c.query(
          "UPDATE tx_test_llm_usage SET status='success' WHERE ref=$1 AND status='reserved'",
          [row.quota_ref],
        );
      } else {
        const marked = await c.query(
          "UPDATE tx_test_llm_usage SET status='refunded' WHERE ref=$1 AND status='reserved' RETURNING id",
          [row.quota_ref],
        );
        if (marked.rows.length) {
          await c.query(
            `UPDATE tx_test_quota_counters SET used = GREATEST(used - 1, 0)
             WHERE owner=$1 AND kind=$2 AND day = CURRENT_DATE`,
            [row.owner_ref, row.quota_kind],
          );
        }
      }
    }

    // 注入点 2：配额已操作，事务尚未提交
    if (opts.failAfterQuotaOp) throw new Error("INJECTED_AFTER_QUOTA_OP");

    await c.query("COMMIT");
    return "settled";
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

describe.skipIf(!hasDb)("事务原子性（真实 PostgreSQL）", () => {
  beforeAll(async () => {
    const pg = await import("pg");
    pool = new pg.default.Pool({ connectionString: TEST_URL, max: 8 });
    await q(`
      CREATE TABLE IF NOT EXISTS tx_test_agent_tasks (
        task_id TEXT PRIMARY KEY, status TEXT, worker_id TEXT,
        attempts INT DEFAULT 0, max_attempts INT DEFAULT 3,
        owner_ref TEXT, quota_ref TEXT, quota_kind TEXT,
        lease_expires_at TIMESTAMPTZ, completed_at TIMESTAMPTZ
      )`);
    await q(`
      CREATE TABLE IF NOT EXISTS tx_test_llm_usage (
        id BIGSERIAL PRIMARY KEY, owner TEXT, kind TEXT,
        detail TEXT, status TEXT, ref TEXT
      )`);
    await q(`
      CREATE TABLE IF NOT EXISTS tx_test_quota_counters (
        owner TEXT, kind TEXT, day DATE, used INT DEFAULT 0,
        PRIMARY KEY (owner, kind, day)
      )`);
  });

  afterAll(async () => {
    // 清理测试表，避免遗留影响同库的其他步骤
    await q("DROP TABLE IF EXISTS tx_test_agent_tasks, tx_test_llm_usage, tx_test_quota_counters").catch(() => {});
    await pool?.end().catch(() => {});
  });

  beforeEach(async () => {
    await q("TRUNCATE tx_test_agent_tasks, tx_test_llm_usage, tx_test_quota_counters");
    await q(
      `INSERT INTO tx_test_agent_tasks (task_id, status, worker_id, owner_ref, quota_ref, quota_kind)
       VALUES ('T1','running','A','u1','Q1','heavy_task')`);
    await q(`INSERT INTO tx_test_llm_usage (owner, kind, status, ref) VALUES ('u1','heavy_task','reserved','Q1')`);
    await q(`INSERT INTO tx_test_quota_counters (owner, kind, day, used) VALUES ('u1','heavy_task',CURRENT_DATE,1)`);
  });

  const quotaState = async () => {
    const usage = await q("SELECT status FROM tx_test_llm_usage WHERE ref='Q1'");
    const counter = await q("SELECT used FROM tx_test_quota_counters WHERE owner='u1' AND kind='heavy_task' AND day=CURRENT_DATE");
    const task = await q("SELECT status, worker_id FROM tx_test_agent_tasks WHERE task_id='T1'");
    return {
      usage: usage[0]?.status,
      used: Number(counter[0]?.used ?? -1),
      taskStatus: task[0]?.status,
    };
  };

  it("Worker B 接管后，陈旧的 Worker A 无法结算且收到 lease_lost", async () => {
    // 回收：A 租约过期，B 重新认领
    await q("UPDATE tx_test_agent_tasks SET worker_id='B' WHERE task_id='T1'");

    const a = await settleInTransaction({ taskId: "T1", workerId: "A", ok: false });
    expect(a).toBe("lease_lost");

    const s = await quotaState();
    expect(s.usage).toBe("reserved");      // A 未退款
    expect(s.used).toBe(1);                // 计数器未回退
    expect(s.taskStatus).toBe("running");  // 任务状态未被 A 改写
  });

  it("Worker B 完成后配额恰好结算一次", async () => {
    await q("UPDATE tx_test_agent_tasks SET worker_id='B' WHERE task_id='T1'");
    await settleInTransaction({ taskId: "T1", workerId: "A", ok: false });   // A 失败

    const b = await settleInTransaction({ taskId: "T1", workerId: "B", ok: true });
    expect(b).toBe("settled");
    expect((await quotaState()).usage).toBe("success");

    // B 重复调用不会二次结算
    const again = await settleInTransaction({ taskId: "T1", workerId: "B", ok: true });
    expect(again).toBe("lease_lost");
    expect((await quotaState()).usage).toBe("success");
  });

  it("任务 UPDATE 之后注入故障 → 任务状态回滚", async () => {
    await expect(
      settleInTransaction({ taskId: "T1", workerId: "A", ok: true, failAfterTaskUpdate: true }),
    ).rejects.toThrow("INJECTED_AFTER_TASK_UPDATE");

    const s = await quotaState();
    expect(s.taskStatus).toBe("running");  // 回滚，未变成 ok
    expect(s.usage).toBe("reserved");
    expect(s.used).toBe(1);
  });

  it("配额操作之后注入故障 → 任务与配额一起回滚", async () => {
    await expect(
      settleInTransaction({ taskId: "T1", workerId: "A", ok: false, failAfterQuotaOp: true }),
    ).rejects.toThrow("INJECTED_AFTER_QUOTA_OP");

    const s = await quotaState();
    expect(s.taskStatus).toBe("running");  // 任务未终态
    expect(s.usage).toBe("reserved");      // 配额未标记 refunded
    expect(s.used).toBe(1);                // 计数器未回退
  });

  it("并发 completeTask / failTask 只产生一次终态转换", async () => {
    await q("UPDATE tx_test_agent_tasks SET worker_id='W' WHERE task_id='T1'");

    // 同一 Worker 并发发起成功与失败结算
    const results = await Promise.allSettled([
      settleInTransaction({ taskId: "T1", workerId: "W", ok: true }),
      settleInTransaction({ taskId: "T1", workerId: "W", ok: false }),
    ]);
    const settled = results.filter((r) => r.status === "fulfilled" && r.value === "settled");
    const lost = results.filter((r) => r.status === "fulfilled" && r.value === "lease_lost");

    expect(settled.length).toBe(1);        // 恰好一次终态
    expect(lost.length).toBe(1);

    // 配额只被结算一次（不可能既 success 又 refunded）
    const s = await quotaState();
    expect(["success", "refunded"]).toContain(s.usage);
    const all = await q("SELECT status FROM tx_test_llm_usage WHERE ref='Q1'");
    expect(all.length).toBe(1);
  });

  it("高并发下终态转换仍只成功一次", async () => {
    await q("UPDATE tx_test_agent_tasks SET worker_id='W' WHERE task_id='T1'");
    const runs = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        settleInTransaction({ taskId: "T1", workerId: "W", ok: i % 2 === 0 })),
    );
    const settled = runs.filter((r) => r.status === "fulfilled" && r.value === "settled");
    expect(settled.length).toBe(1);
  });
});

describe.skipIf(!hasDb)("配额路径原子性（真实 PostgreSQL）", () => {
  /** 复刻 reserveQuota 的事务语义，可在两步之间注入故障 */
  async function reserveInTx(opts: {
    owner: string; kind: string; quota: number; ref: string; failAfterCounter?: boolean;
  }): Promise<{ ok: boolean; used?: number }> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const rs = await c.query(
        `INSERT INTO tx_test_quota_counters (owner, kind, day, used) VALUES ($1,$2,CURRENT_DATE,1)
         ON CONFLICT (owner, kind, day)
         DO UPDATE SET used = tx_test_quota_counters.used + 1
         WHERE tx_test_quota_counters.used < $3
         RETURNING used`,
        [opts.owner, opts.kind, opts.quota],
      );
      if (!rs.rows.length) { await c.query("ROLLBACK"); return { ok: false }; }

      // 注入点：计数器已增加，预占记录尚未写入
      if (opts.failAfterCounter) throw new Error("INJECTED_BEFORE_RESERVATION");

      await c.query(
        `INSERT INTO tx_test_llm_usage (owner, kind, status, ref) VALUES ($1,$2,'reserved',$3)`,
        [opts.owner, opts.kind, opts.ref],
      );
      await c.query("COMMIT");
      return { ok: true, used: Number(rs.rows[0].used) };
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally { c.release(); }
  }

  /** 复刻 refundQuota：只有 reserved→refunded 命中才回退计数器 */
  async function refundInTx(owner: string, kind: string, ref: string): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const marked = await c.query(
        `UPDATE tx_test_llm_usage SET status='refunded' WHERE ref=$1 AND status='reserved' RETURNING id`,
        [ref],
      );
      if (marked.rows.length) {
        await c.query(
          `UPDATE tx_test_quota_counters SET used = GREATEST(used - 1, 0)
           WHERE owner=$1 AND kind=$2 AND day = CURRENT_DATE`,
          [owner, kind],
        );
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally { c.release(); }
  }

  const counterOf = async (owner: string, kind: string) => {
    const r = await q(
      `SELECT used FROM tx_test_quota_counters WHERE owner=$1 AND kind=$2 AND day=CURRENT_DATE`,
      [owner, kind]);
    return Number(r[0]?.used ?? 0);
  };

  beforeEach(async () => {
    await q("TRUNCATE tx_test_llm_usage, tx_test_quota_counters");
  });

  it("预占：计数器自增后注入失败 → 计数器回滚，不留残缺 reservation", async () => {
    // 先成功占一次，确认基线
    await reserveInTx({ owner: "u1", kind: "k", quota: 5, ref: "R1" });
    expect(await counterOf("u1", "k")).toBe(1);

    // 第二次在写入 reservation 前失败
    await expect(
      reserveInTx({ owner: "u1", kind: "k", quota: 5, ref: "R2", failAfterCounter: true }),
    ).rejects.toThrow("INJECTED_BEFORE_RESERVATION");

    // 计数器必须保持原值，不能因为失败的尝试而泄漏额度
    expect(await counterOf("u1", "k")).toBe(1);
    const orphan = await q("SELECT id FROM tx_test_llm_usage WHERE ref='R2'");
    expect(orphan.length).toBe(0);      // 无残缺 reservation
  });

  it("退款幂等：同一 ref 连续退两次，计数器只减一次", async () => {
    await reserveInTx({ owner: "u2", kind: "k", quota: 5, ref: "R10" });
    await reserveInTx({ owner: "u2", kind: "k", quota: 5, ref: "R11" });
    expect(await counterOf("u2", "k")).toBe(2);

    await refundInTx("u2", "k", "R10");
    expect(await counterOf("u2", "k")).toBe(1);

    await refundInTx("u2", "k", "R10");   // 重复退款
    expect(await counterOf("u2", "k")).toBe(1);   // 不再递减

    const st = await q("SELECT status FROM tx_test_llm_usage WHERE ref='R10'");
    expect(st[0].status).toBe("refunded");
  });

  it("退款不存在的 ref 不影响计数器", async () => {
    await reserveInTx({ owner: "u3", kind: "k", quota: 5, ref: "R20" });
    await refundInTx("u3", "k", "NOT_EXIST");
    expect(await counterOf("u3", "k")).toBe(1);
  });

  it("配额用尽时不写入 reservation，计数器不超上限", async () => {
    for (let i = 0; i < 3; i++) {
      await reserveInTx({ owner: "u4", kind: "k", quota: 3, ref: `R3${i}` });
    }
    expect(await counterOf("u4", "k")).toBe(3);

    const over = await reserveInTx({ owner: "u4", kind: "k", quota: 3, ref: "R99" });
    expect(over.ok).toBe(false);
    expect(await counterOf("u4", "k")).toBe(3);          // 未超限
    const none = await q("SELECT id FROM tx_test_llm_usage WHERE ref='R99'");
    expect(none.length).toBe(0);
  });

  it("并发预占不会超发配额", async () => {
    const runs = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        reserveInTx({ owner: "u5", kind: "k", quota: 4, ref: `C${i}` })),
    );
    const granted = runs.filter((r) => r.status === "fulfilled" && (r as any).value.ok).length;
    expect(granted).toBe(4);                             // 恰好发放上限数量
    expect(await counterOf("u5", "k")).toBe(4);
    const reservations = await q("SELECT id FROM tx_test_llm_usage WHERE status='reserved'");
    expect(reservations.length).toBe(4);                 // 计数器与记录一致
  });

  it("死信回收：标记 dead 与退款同事务，注入失败时一起回滚", async () => {
    await reserveInTx({ owner: "u6", kind: "heavy_task", quota: 5, ref: "RD1" });
    await q(`INSERT INTO tx_test_agent_tasks (task_id, status, worker_id, attempts, max_attempts, owner_ref, quota_ref, quota_kind, lease_expires_at)
             VALUES ('TD1','running','X',3,3,'u6','RD1','heavy_task', now() - interval '1 hour')`);

    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        `UPDATE tx_test_agent_tasks SET status='dead', completed_at=now()
         WHERE status='running' AND lease_expires_at < now() AND attempts >= max_attempts`);
      await c.query(`UPDATE tx_test_llm_usage SET status='refunded' WHERE ref='RD1' AND status='reserved'`);
      throw new Error("INJECTED_IN_RECLAIM");
    } catch {
      await c.query("ROLLBACK").catch(() => {});
    } finally { c.release(); }

    // 任务与配额必须一起回滚：不能出现「已 dead 但配额仍 reserved」
    const task = await q("SELECT status FROM tx_test_agent_tasks WHERE task_id='TD1'");
    const usage = await q("SELECT status FROM tx_test_llm_usage WHERE ref='RD1'");
    expect(task[0].status).toBe("running");
    expect(usage[0].status).toBe("reserved");
    expect(await counterOf("u6", "heavy_task")).toBe(1);
  });
});

describe.skipIf(hasDb)("事务集成测试未运行", () => {
  it("提示如何启用（不静默跳过）", () => {
    console.warn(
      "\n⚠ 未设置 TEST_DATABASE_URL，事务原子性集成测试已跳过。" +
      "\n  本地启用：docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=ci -e POSTGRES_USER=ci -e POSTGRES_DB=nuedc_test postgres:16" +
      "\n  然后：TEST_DATABASE_URL=postgresql://ci:ci@127.0.0.1:5432/nuedc_test npx vitest run tests/tx-integration.test.ts" +
      "\n  CI 中由 postgres:16 service 自动提供。\n",
    );
    expect(true).toBe(true);
  });
});