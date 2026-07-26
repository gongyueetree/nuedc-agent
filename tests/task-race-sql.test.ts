import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";

/** 在内存 Postgres 上真实执行状态转换 SQL，验证竞态语义。
 *  这不是源码契约检查 —— 是让数据库真的跑一遍条件 UPDATE。 */

function setup() {
  const db = newDb();
  db.public.none(`
    CREATE TABLE agent_tasks (
      task_id TEXT PRIMARY KEY, status TEXT, worker_id TEXT,
      attempts INT DEFAULT 0, max_attempts INT DEFAULT 3,
      owner_ref TEXT, quota_ref TEXT, quota_kind TEXT,
      error TEXT, error_code TEXT, dead_reason TEXT,
      output TEXT, last_run_id TEXT,
      lease_expires_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
    );
    INSERT INTO agent_tasks (task_id, status, worker_id, attempts, owner_ref, quota_ref, quota_kind)
    VALUES ('T1', 'running', 'A', 3, 'u1', 'Q1', 'heavy_task');
  `);
  return db;
}

/** 复刻 failTask 的 dead 分支语义 */
function failDead(db: any, worker: string): { outcome: string; quota?: string } {
  const rows = db.public.many(`
    UPDATE agent_tasks SET status='dead', worker_id=NULL, dead_reason='test', completed_at=now()
    WHERE task_id='T1' AND status='running' AND worker_id='${worker}'
    RETURNING owner_ref, quota_ref, quota_kind`);
  if (!rows.length) return { outcome: "lease_lost" };
  return { outcome: "dead", quota: rows[0].quota_ref };
}

/** 复刻 completeTask 语义 */
function complete(db: any, worker: string): string {
  const rows = db.public.many(`
    UPDATE agent_tasks SET status='ok', completed_at=now()
    WHERE task_id='T1' AND status='running' AND worker_id='${worker}'
    RETURNING owner_ref, quota_ref`);
  return rows.length ? "settled" : "lease_lost";
}

describe("租约竞态（真实 SQL）", () => {
  it("A 租约过期被 B 接管后，A 的 failTask 返回 lease_lost 且不结算", () => {
    const db = setup();
    let settlements = 0;

    // 回收：A 的租约过期，B 重新认领
    db.public.none(`UPDATE agent_tasks SET worker_id='B', attempts=attempts+1 WHERE task_id='T1'`);

    const a = failDead(db, "A");
    expect(a.outcome).toBe("lease_lost");
    if (a.outcome === "dead") settlements++;
    expect(settlements).toBe(0);              // A 绝不能结算

    const b = failDead(db, "B");
    expect(b.outcome).toBe("dead");
    expect(b.quota).toBe("Q1");
    if (b.outcome === "dead") settlements++;
    expect(settlements).toBe(1);              // 恰好一次
  });

  it("同一 Worker 重复调用不会二次结算", () => {
    const db = setup();
    let settlements = 0;
    for (let i = 0; i < 3; i++) {
      if (failDead(db, "A").outcome === "dead") settlements++;
    }
    expect(settlements).toBe(1);
  });

  it("completeTask 在租约丢失时同样返回 lease_lost", () => {
    const db = setup();
    db.public.none(`UPDATE agent_tasks SET worker_id='B' WHERE task_id='T1'`);
    expect(complete(db, "A")).toBe("lease_lost");
    expect(complete(db, "B")).toBe("settled");
    expect(complete(db, "B")).toBe("lease_lost");   // 已终态，不可重复写
  });

  it("已完成的任务不能被旧 Worker 改写终态", () => {
    const db = setup();
    complete(db, "A");                                   // A 正常完成
    const after = failDead(db, "A");                     // A 再报失败
    expect(after.outcome).toBe("lease_lost");
    const row = db.public.many(`SELECT status FROM agent_tasks WHERE task_id='T1'`)[0];
    expect(row.status).toBe("ok");                       // 终态未被覆盖
  });

  it("重新入队要求 attempts < max_attempts", () => {
    const db = setup();
    // attempts=3, max=3 → 不满足，不应重新入队
    const rows = db.public.many(`
      UPDATE agent_tasks SET status='queued', worker_id=NULL
      WHERE task_id='T1' AND status='running' AND worker_id='A' AND attempts < max_attempts
      RETURNING task_id`);
    expect(rows.length).toBe(0);
  });
});
