import { describe, it, expect } from "vitest";

/** Worker 与配额一致性。数据库相关逻辑用契约检查 + 纯逻辑验证。 */

describe("任务队列：原子认领与租约", () => {
  it("认领 SQL 使用 FOR UPDATE SKIP LOCKED，多 Worker 不会抢到同一条", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/task-queue.ts", "utf8");
    expect(src).toContain("FOR UPDATE SKIP LOCKED");
    expect(src).toContain("ORDER BY priority ASC");     // 按优先级
    expect(src).toContain("scheduled_at IS NULL OR scheduled_at <= now()");  // 尊重延迟调度
  });

  it("认领即设置租约与心跳时间", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/task-queue.ts", "utf8");
    expect(src).toContain("lease_expires_at = now() + interval");
    expect(src).toContain("heartbeat_at = now()");
  });

  it("回收循环把过期租约任务重新入队，超限进死信", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/task-queue.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function reclaimExpired"), src.indexOf("export async function completeTask"));
    expect(fn).toContain("status='queued'");            // 重新入队
    expect(fn).toContain("attempts < max_attempts");
    expect(fn).toContain("status='dead'");              // 死信
    expect(fn).toContain("refundQuota");                // 死信必须退款
  });

  it("心跳失效后 Worker 不再写结果（防止已回收任务被覆盖）", async () => {
    const fs = await import("node:fs");
    const q = fs.readFileSync("lib/task-queue.ts", "utf8");
    // completeTask 带 worker_id 与 status='running' 条件，被回收后更新影响 0 行
    const fn = q.slice(q.indexOf("export async function completeTask"));
    expect(fn).toContain("AND status='running' AND worker_id=?");
    // 租约丢失时返回 lease_lost 而非静默 return，调用方能据此丢弃结果
    expect(fn).toContain('return "lease_lost"');
  });
});

describe("配额一致性", () => {
  it("任务成功才 commit，失败/取消一律 refund", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/task-queue.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function completeTask"), src.indexOf("export async function failTask"));
    expect(fn).toContain("if (opts.ok && !opts.canceled) await commitQuota");
    expect(fn).toContain("else await refundQuota");
  });

  it("预占在建任务时完成并绑定 quota_ref", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/agent-tasks/route.ts", "utf8");
    expect(src).toContain("reserveQuota");
    expect(src).toContain("quota_ref");
    expect(src).toContain("quota_kind");
  });

  it("commitQuota 只对 reserved 状态生效（重复调用幂等）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/usage.ts", "utf8");
    expect(src).toContain("WHERE ref=? AND status='reserved'");
  });

  it("重型任务有每日配额，防止单用户刷爆预算", async () => {
    const { quotaFor } = await import("../lib/usage");
    expect(quotaFor("heavy_task", "free")).toBeGreaterThan(0);
    expect(quotaFor("heavy_task", "paid")).toBeGreaterThan(quotaFor("heavy_task", "free"));
    expect(quotaFor("heavy_task", "admin")).toBe(-1);
  });
});

describe("Worker 部署形态", () => {
  it("提供常驻 Worker 脚本，支持并发槽位与优雅退出", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/agent-worker.mts", "utf8");
    expect(src).toContain("SIGTERM");
    expect(src).toContain("WORKER_HEAVY_SLOTS");
    expect(src).toContain("WORKER_LIGHT_SLOTS");
    expect(src).toContain("reclaimLoop");
    expect(src).toContain("heartbeat");
    // 退出时释放租约，让其他 Worker 立即接管
    expect(src).toContain("status='queued', worker_id=NULL");
  });

  it("execute 路由默认生产关闭，仅 admin/debug 或显式开关可用", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/agent-tasks/[id]/execute/route.ts", "utf8");
    expect(src).toContain("ALLOW_INLINE_EXECUTE");
    expect(src).toContain('resolveTier(req) !== "admin"');
    expect(src).toContain("worker_mode: true");
  });

  it("前端在 Worker 模式下只轮询不点火", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/api.ts", "utf8");
    expect(src).toContain("if (d?.worker_mode) return;");
    expect(src).toContain('st.status === "dead"');      // 死信状态有明确提示
  });
});

describe("数据库驱动选择（CI 与自建部署）", () => {
  it("Neon 域名走 HTTP 驱动，其余走标准连接池", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/db.ts", "utf8");
    expect(src).toContain("postgres_pool");
    expect(src).toContain("neon.tech");       // 按主机名自动判断
    expect(src).toContain("DB_DRIVER");       // 支持显式覆盖
  });

  it("提供连接池关闭方法，Worker 退出时释放", async () => {
    const fs = await import("node:fs");
    expect(fs.readFileSync("lib/db.ts", "utf8")).toContain("export async function closeDb");
    expect(fs.readFileSync("scripts/agent-worker.mts", "utf8")).toContain("await closeDb()");
  });

  it("驱动信息在 /api/ready 中可见，便于确认连的是哪种库", async () => {
    const fs = await import("node:fs");
    expect(fs.readFileSync("app/api/ready/route.ts", "utf8")).toContain("db_driver");
  });
});

describe("固件编译 workflow 的可选性", () => {
  it("未配置 Secrets 时跳过而非失败（避免定时任务反复报错）", async () => {
    const fs = await import("node:fs");
    const wf = fs.readFileSync(".github/workflows/build-firmware.yml", "utf8");
    // 先探测再决定是否执行
    expect(wf).toContain("needs.check.outputs.configured == 'true'");
    expect(wf).toContain("::notice::");
    expect(wf).not.toContain("exit 1");
  });

  it("build-runner 缺少 ADMIN_API_KEY 时以 0 退出", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/build-runner.mts", "utf8");
    const guard = src.slice(src.indexOf("const KEY ="), src.indexOf("const H ="));
    expect(guard).toContain("process.exit(0)");
    expect(guard).not.toContain("process.exit(1)");
    expect(guard).toContain("跳过固件编译");
  });
})

describe("Worker 存活性与就绪检查（heavy 压测依赖）", () => {
  it("Worker 独立上报存活，空闲时也上报", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/agent-worker.mts", "utf8");
    expect(src).toContain("aliveLoop");
    expect(src).toContain("reportWorkerAlive");
    // 启动即上报，缩短 CI 等待
    expect(src).toContain("await report();");
    // 退出时注销，让 readiness 立刻反映下线
    expect(src).toContain("unregisterWorker");
  });

  it("workerStatus 用时间窗口判断存活，不只看记录是否存在", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/task-queue.ts", "utf8");
    expect(src).toContain("WORKER_LIVE_WINDOW_SEC");
    expect(src).toContain("last_seen < now() - interval");
    expect(src).toContain("stale");
  });

  it("/api/admin/readiness 提供可断言的结构化指标", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/admin/readiness/route.ts", "utf8");
    for (const k of ["workers", "queue", "providers", "system_mode", "migrations_applied"]) {
      expect(src, `readiness 缺少 ${k}`).toContain(k);
    }
    // 含运行拓扑，必须限管理员
    expect(src).toContain('resolveTier(req) !== "admin"');
  });

  it("assert-readiness 按模式区分要求：mock-provider 要 Worker，queue-only 反而不要", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/assert-readiness.mjs", "utf8");
    expect(src).toContain('MODE === "mock-provider"');
    expect(src).toContain('MODE === "queue-only"');
    expect(src).toContain("没有存活 Worker");
    expect(src).toContain("会消费掉任务导致队列指标失真");
    // 压测绝不能烧真钱
    expect(src).toContain("mock 模式");
    expect(src).toContain("会产生真实费用");
  });

  it("collect-db-stats 收集瓶颈定位所需的指标", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/collect-db-stats.mjs", "utf8");
    for (const s of ["任务状态分布", "Worker 心跳", "数据库连接", "模型调用统计"]) {
      expect(src, `缺少统计项 ${s}`).toContain(s);
    }
    // 无数据库时不能让 CI 红灯
    expect(src).toContain("跳过数据库统计");
  });

  it("压测支持 mock-provider 模式（heavy workflow 使用）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/load-test.mts", "utf8");
    expect(src).toContain('RAW_MODE === "mock-provider"');
    expect(src).toContain("MODE_LABEL");
  });
});
