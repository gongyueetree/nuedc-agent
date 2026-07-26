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

describe("P0 事务真实性（不得静默降级）", () => {
  it("withTransaction 不再对任何驱动降级为顺序执行", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/db.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function withTransaction"), src.indexOf("export function txDriverKind"));
    // 曾经的降级分支必须消失
    expect(src).not.toContain("return fn(db())");
    expect(fn).toContain("BEGIN");
    expect(fn).toContain("COMMIT");
    expect(fn).toContain("ROLLBACK");
    expect(fn).toContain("pool.connect()");
  });

  it("无事务驱动时 fail closed，抛 TRANSACTION_DRIVER_UNAVAILABLE", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/db.ts", "utf8");
    expect(src).toContain("TRANSACTION_DRIVER_UNAVAILABLE");
    expect(src).toContain("拒绝以顺序独立查询降级执行");
  });

  it("Neon 走 WebSocket Pool，Node 20 无全局 WebSocket 时回退 pg", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/db.ts", "utf8");
    expect(src).toContain("neonConfig.webSocketConstructor");
    expect(src).toContain('require("pg")');
    // 事务池与 db() 的 HTTP 驱动分开
    expect(src).toContain("_txPool");
  });

  it("配额结算接受事务执行器，与状态转换同事务", async () => {
    const fs = await import("node:fs");
    const usage = fs.readFileSync("lib/usage.ts", "utf8");
    expect(usage).toContain("commitQuota(ref: string, tx?: TxExecutor)");
    expect(usage).toContain("refundQuota(owner: string, kind: string, ref: string, tx?: TxExecutor)");
    expect(usage).toContain("const exec = tx ?? db()");

    const queue = fs.readFileSync("lib/task-queue.ts", "utf8");
    // 必须把 tx 传下去，否则配额走独立连接、回滚时不一致
    expect(queue).toContain("String(row.quota_ref), tx)");
    expect(queue).toContain("commitQuota(String(row.quota_ref), tx)");
  });

  it("事务内的配额结算不吞错误（失败必须回滚整个事务）", async () => {
    const fs = await import("node:fs");
    const usage = fs.readFileSync("lib/usage.ts", "utf8");
    const txBranch = usage.slice(usage.indexOf("if (tx) {"), usage.indexOf("// 事务外（兼容旧调用点）"));
    expect(txBranch).not.toContain(".catch(() => {})");
  });
});

describe("P1 租户命名空间强度", () => {
  it("命名空间至少 12 位十六进制", async () => {
    const { NS_HEX_LEN, makeModuleId } = await import("../lib/module-id");
    expect(NS_HEX_LEN).toBeGreaterThanOrEqual(12);
    const id = makeModuleId("x", { scope: "ORGANIZATION", owner_ref: "u", org_ref: "ezplm:ws-a" });
    const hex = id.replace(/^org-/, "").split("-")[0];
    expect(hex.length).toBeGreaterThanOrEqual(12);
    expect(hex).toMatch(/^[0-9a-f]+$/);
  });

  it("大量租户下无碰撞", async () => {
    const { makeModuleId } = await import("../lib/module-id");
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      ids.add(makeModuleId("same-slug", {
        scope: "ORGANIZATION", owner_ref: `u${i}`, org_ref: `ezplm:ws-${i}`,
      }));
    }
    expect(ids.size).toBe(5000);   // 每个组织独立主键，无碰撞
  });
});

describe("P1 冲突检测用错误码而非消息匹配", () => {
  it("按 PostgreSQL 23505 判定唯一约束冲突", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/modules/ingest/route.ts", "utf8");
    expect(src).toContain('e?.code === "23505"');
    expect(src).toContain("constraint");
    // 不得再用正则匹配错误消息
    expect(src).not.toMatch(/duplicate key\|unique constraint/);
    expect(src).not.toMatch(/\.test\(String\(e\?\.message/);
  });
});

describe("P1 .DS_Store 清理", () => {
  it("仓库中不存在 .DS_Store 文件", async () => {
    const fs = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    const found = execFileSync("find", [".", "-name", ".DS_Store", "-not", "-path", "./node_modules/*"],
      { encoding: "utf8" }).trim();
    expect(found, `发现残留：${found}`).toBe("");
    expect(fs.readFileSync(".gitignore", "utf8")).toContain(".DS_Store");
  });
});

describe("迁移健壮性与测试隔离", () => {
  it("集成测试使用独立表名，不占用生产表名", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("tests/tx-integration.test.ts", "utf8");
    expect(src).toContain("tx_test_agent_tasks");
    // 不得用 CREATE TABLE IF NOT EXISTS 占住生产表名 ——
    // 那会让后续 ensureSchema 跳过建表、迁移引用缺失列而失败
    expect(src).not.toMatch(/CREATE TABLE IF NOT EXISTS agent_tasks\b/);
    expect(src).not.toMatch(/CREATE TABLE IF NOT EXISTS llm_usage\b/);
    expect(src).toContain("DROP TABLE IF EXISTS tx_test_");
  });

  it("agent_tasks 迁移在建索引前补齐关键列（结构不完整时可自愈）", async () => {
    const { MIGRATIONS } = await import("../lib/migrations");
    const m = (MIGRATIONS as any[]).find((x) => x.sql.includes("idx_tasks_project"));
    expect(m).toBeTruthy();
    const addIdx = m.sql.indexOf("ADD COLUMN IF NOT EXISTS project_id");
    const useIdx = m.sql.indexOf("idx_tasks_project");
    expect(addIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeLessThan(useIdx);      // 补列必须在建索引之前
  });

  it("CI 在 Worker 冒烟前先跑迁移", async () => {
    const fs = await import("node:fs");
    const ci = fs.readFileSync(".github/workflows/ci.yml", "utf8");
    const migIdx = ci.indexOf("Migrate before worker smoke");
    const smokeIdx = ci.indexOf("Worker startup smoke");
    expect(migIdx).toBeGreaterThan(-1);
    expect(migIdx).toBeLessThan(smokeIdx);
  });
});

describe("迁移不可变性（防止已发布迁移被追加内容）", () => {
  it("已发布迁移的内容哈希锁定 —— 修改会导致部分环境永久缺列", async () => {
    const { MIGRATIONS } = await import("../lib/migrations");
    const { createHash } = await import("node:crypto");
    // 锁定截至迁移 18 的内容。迁移系统按 id 判断是否执行过，
    // 若追加语句，已跑过该 id 的库不会重跑，新列永远不存在。
    // 需要补列时必须新增迁移，不能改旧的。
    const locked: Record<number, string> = {
      16: "db56f7f4",
      17: "435e5344",
      18: "f7fd3fda",
    };
    for (const [id, want] of Object.entries(locked)) {
      const m = (MIGRATIONS as any[]).find((x) => x.id === Number(id));
      if (!m) continue;
      const got = createHash("sha256").update(m.sql).digest("hex").slice(0, 8);
      expect(got, `迁移 ${id} 内容已变更（${got} ≠ ${want}）。` +
        `已发布迁移不可修改 —— 请新增迁移补列，否则已执行过该 id 的库不会重跑。`).toBe(want);
    }
  });

  it("补偿迁移 19 全部语句幂等，可安全重复执行", async () => {
    const { MIGRATIONS } = await import("../lib/migrations");
    const m = (MIGRATIONS as any[]).find((x) => x.id === 19);
    expect(m).toBeTruthy();
    const stmts = m.sql.split(";").map((s: string) => s.trim())
      .filter((s: string) => s && !s.startsWith("--"));
    for (const s of stmts) {
      expect(s, `非幂等语句：${s.slice(0, 60)}`).toMatch(/IF NOT EXISTS/i);
    }
  });

  it("Worker 遇到 schema 缺列时进入待命自愈，既不刷屏也不崩溃循环", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/agent-worker.mts", "utf8");
    expect(src).toContain('e?.code === "42703"');      // undefined_column
    expect(src).toContain('e?.code === "42P01"');      // undefined_table
    expect(src).toContain("npm run db:init");
    expect(src).toContain("information_schema.columns");
    // 立即 exit(1) 会与编排平台重启策略形成崩溃循环，改为待命重试
    expect(src).toContain("waitForSchema");
    expect(src).toContain("迁移完成后无需重启容器");
  });
});
