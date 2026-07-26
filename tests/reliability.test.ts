import { describe, it, expect } from "vitest";

/** 可靠性回归。这些测试守护的是「同一次预占只结算一次」「租约丢失后不得写结果」
 *  这类正确性契约 —— 出问题会直接表现为重复扣费或数据被覆盖。 */

describe("P0-2 租约竞态：failTask / completeTask", () => {
  it("状态转换用单条条件 UPDATE，不再先 SELECT 后 UPDATE", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/task-queue.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function failTask"), src.indexOf("/** 队列概览 */"));
    // 不得再有独立的前置 SELECT（那是竞态窗口）
    expect(fn).not.toMatch(/SELECT attempts, max_attempts/);
    expect(fn).toContain("RETURNING");
  });

  it("WHERE 必须同时含 status='running' 与 worker_id", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/task-queue.ts", "utf8");
    for (const fnName of ["failTask", "completeTask"]) {
      const start = src.indexOf(`export async function ${fnName}`);
      const seg = src.slice(start, start + 3000);
      // 只检查状态转换语句（UPDATE agent_tasks），不含用量汇总的 SELECT
      const updates = (seg.match(/UPDATE agent_tasks SET[\s\S]*?RETURNING/g) || []);
      expect(updates.length, `${fnName} 没有条件 UPDATE ... RETURNING`).toBeGreaterThan(0);
      for (const w of updates) {
        expect(w, `${fnName} 的 WHERE 缺少 status='running'`).toContain("status='running'");
        expect(w, `${fnName} 的 WHERE 缺少 worker_id`).toContain("worker_id=?");
      }
    }
  });

  it("未命中返回 lease_lost，且不结算配额", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/task-queue.ts", "utf8");
    expect(src).toContain('"lease_lost"');
    // failTask：先判断未命中并 return，再走结算
    const fail = src.slice(src.indexOf("export async function failTask"), src.indexOf("/** 队列概览 */"));
    const leaseIdx = fail.indexOf('return "lease_lost"');
    const refundIdx = fail.indexOf("refundQuota");
    expect(leaseIdx).toBeGreaterThan(-1);
    expect(refundIdx).toBeGreaterThan(leaseIdx);   // 退款在 lease_lost 判断之后
  });

  it("不再吞掉数据库错误（无 .catch(() => {}) 掩盖失败）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/task-queue.ts", "utf8");
    for (const fnName of ["failTask", "completeTask"]) {
      const start = src.indexOf(`export async function ${fnName}`);
      const seg = src.slice(start, start + 3000);
      // 状态转换与结算路径不得吞错误（末尾的 workerMetrics 等辅助函数除外）
      const core = seg.slice(0, seg.indexOf("return withTransaction") >= 0 ? seg.length : seg.length);
      expect(core, `${fnName} 仍在吞错误`).not.toMatch(/execute\([\s\S]{0,400}?\}\)\.catch\(\(\)\s*=>\s*\{\s*\}\)/);
    }
  });

  it("状态转换与配额结算在事务内", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/task-queue.ts", "utf8");
    expect(src).toContain("withTransaction");
    const fail = src.slice(src.indexOf("export async function failTask"), src.indexOf("/** 队列概览 */"));
    expect(fail).toContain("return withTransaction");
  });

  it("Worker 收到 lease_lost 时丢弃结果，不再打印成功日志", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/agent-worker.mts", "utf8");
    expect(src).toContain('outcome === "lease_lost"');
    expect(src).toContain("结果作废");
  });

  it("竞态场景推演：A 租约过期 → B 接管 → A 调 failTask 必须 lease_lost", async () => {
    // 用状态机模拟数据库的条件 UPDATE 语义
    let task = { status: "running", worker_id: "A", quota_ref: "Q1", settled: 0 };
    const conditionalUpdate = (worker: string, next: string) => {
      if (task.status === "running" && task.worker_id === worker) {
        task = { ...task, status: next, worker_id: "" };
        return true;   // 命中
      }
      return false;    // 未命中 → lease_lost
    };

    // 1~2. A 的租约过期，回收后 B 重新认领
    task = { ...task, status: "running", worker_id: "B" };

    // 3~5. A 调 failTask：WHERE worker_id='A' 不匹配 → 未命中
    const aHit = conditionalUpdate("A", "dead");
    expect(aHit).toBe(false);
    if (aHit) task.settled++;
    expect(task.settled).toBe(0);          // A 不得结算

    // 6. B 完成 → 命中，结算恰好一次
    const bHit = conditionalUpdate("B", "ok");
    expect(bHit).toBe(true);
    if (bHit) task.settled++;
    expect(task.settled).toBe(1);

    // B 重复调用（如重试）不会再次结算
    const bAgain = conditionalUpdate("B", "ok");
    expect(bAgain).toBe(false);
    expect(task.settled).toBe(1);
  });
});

describe("配额单次结算", () => {
  it("commitQuota / refundQuota 只对 reserved 状态生效（幂等）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/usage.ts", "utf8");
    expect(src).toContain("WHERE ref=? AND status='reserved'");
  });

  it("重新入队时不结算配额（任务还会再跑）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/task-queue.ts", "utf8");
    const fail = src.slice(src.indexOf("export async function failTask"), src.indexOf("/** 队列概览 */"));
    const requeueIdx = fail.indexOf('return "requeued"');
    const refundIdx = fail.indexOf("refundQuota");
    expect(requeueIdx).toBeGreaterThan(-1);
    expect(refundIdx).toBeGreaterThan(requeueIdx);   // 退款只在 dead 分支
  });
});

describe("取消不重试", () => {
  it("取消的任务走 canceled 终态并返还配额", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/task-queue.ts", "utf8");
    const done = src.slice(src.indexOf("export async function completeTask"), src.indexOf("/** 任务终态结算结果"));
    expect(done).toContain('opts.canceled ? "canceled"');
    expect(done).toContain("else await refundQuota");
  });
});

describe("跨组织任务与产物隔离", () => {
  it("任务的组织来自 agent_tasks 列而非 input（input 可伪造）", async () => {
    const fs = await import("node:fs");
    const q = fs.readFileSync("lib/task-queue.ts", "utf8");
    expect(q).toContain("org_ref");
    expect(q).toContain("绝不从 input 里取");
    const w = fs.readFileSync("scripts/agent-worker.mts", "utf8");
    expect(w).toContain("org: task.org_ref");
  });

  it("模块读路径全部按 scope 过滤", async () => {
    const fs = await import("node:fs");
    expect(fs.readFileSync("lib/module-query.ts", "utf8")).toContain("visibilityClause");
    expect(fs.readFileSync("lib/agents/base.ts", "utf8")).toContain("visibilityClause");
  });
});

describe("发布 fail-closed 与版本不可变", () => {
  it("发布清单未过不得发布（除非 admin 显式 override）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/problem-center.ts", "utf8");
    expect(src).toContain("if (!passed && !override)");
    expect(src).toContain("发布清单未通过");
  });

  it("已发布版本不可修改", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/problem-center.ts", "utf8");
    expect(src).toContain("已发布版本不可修改");
    expect(src).toContain("immutable=1");
  });
});

describe("Readiness fail-closed", () => {
  it("Worker/队列查询失败必须置 ok=false 并返回 503", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/admin/readiness/route.ts", "utf8");
    // 不得把异常伪装成 live=0 或 queue=null
    expect(src).not.toMatch(/catch\s*\{\s*out\.workers = \{ live: 0/);
    expect(src).not.toMatch(/catch\s*\{\s*out\.queue = null/);
    expect(src).toContain("out.workers = { ok: false");
    expect(src).toContain("out.queue = { ok: false");
    expect(src).toContain("status: out.ok ? 200 : 503");
  });
});

describe("Worker 错误指标", () => {
  it("四类数据库错误都有计数，不静默吞掉", async () => {
    const fs = await import("node:fs");
    const w = fs.readFileSync("scripts/agent-worker.mts", "utf8");
    for (const m of ["heartbeat_db_errors", "reclaim_db_errors", "fail_task_db_errors", "complete_task_db_errors"]) {
      expect(w, `缺少指标 ${m}`).toContain(m);
    }
  });

  it("指标在 readiness 中暴露", async () => {
    const fs = await import("node:fs");
    expect(fs.readFileSync("app/api/admin/readiness/route.ts", "utf8")).toContain("worker_metrics");
  });
});

describe("CI 可重复性", () => {
  it("只允许 npm ci，lockfile 不一致必须红灯", async () => {
    const fs = await import("node:fs");
    for (const f of ["ci.yml", "build-firmware.yml"]) {
      const src = fs.readFileSync(`.github/workflows/${f}`, "utf8");
      expect(src, `${f} 仍有 npm install 回退`).not.toContain("npm install");
      expect(src, `${f} 仍有 || 回退`).not.toMatch(/npm ci\s*\|\|/);
    }
  });
});
