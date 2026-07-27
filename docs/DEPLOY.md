# 部署清单

## 1. Web（Vercel）

必需环境变量：

```
DATABASE_URL=postgresql://...        # Neon 连接串
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
ADMIN_API_KEY=...                    # 管理后台与运维面板
```

推送代码后 Vercel 自动部署。**每次有新迁移时**在本地执行：

```bash
DATABASE_URL='你的连接串' npm run db:init
```

## 1.5 数据库驱动

系统同时支持两种驱动，**默认按连接串自动判断**，通常无需配置：

| 连接串主机 | 驱动 | 适用 |
|---|---|---|
|  | （HTTP） | Vercel 等无常驻连接环境 |
| 其他（含 127.0.0.1、内网、Docker） | （连接池） | 自建服务器、Docker、CI |

需要覆盖时设  或 。
当前生效的驱动可在 （admin）的  字段确认。

## 2. Worker（常驻进程，必需）

Web 只负责入队，**任务由 Worker 执行**。未部署 Worker 时任务会一直排队。

在能连到同一个数据库的机器上：

```bash
cd nuedc-agent && npm ci
DATABASE_URL='同一个连接串' \
GEMINI_API_KEY='...' \
pm2 start npm --name nuedc-worker -- run worker
pm2 logs nuedc-worker
```

### 容器部署（Railway / Fly.io / 自建 Docker）

镜像定义在 `docker/Dockerfile.worker`。Railway 配置：

- Builder: **Dockerfile**
- Dockerfile path: **docker/Dockerfile.worker**
- Restart policy: on failure（Worker 在数据库不可用时会主动退出，靠重启策略恢复）

必需环境变量：`DATABASE_URL`（与 Web 同库）、`GEMINI_API_KEY`。
连普通 Postgres 时驱动会自动切换到连接池，无需额外配置。

可调：

```
WORKER_HEAVY_SLOTS=2              # 重型任务并发
WORKER_LIGHT_SLOTS=6              # 轻型任务并发
WORKER_SHUTDOWN_GRACE_MS=30000    # 优雅退出宽限期
WORKER_MAX_CONSECUTIVE_FAILURES=10  # 连续失败多少次后退出重启
```

**故障行为**：数据库不可达时 Worker 会打印原因并退出（非僵死），
由编排平台重启；收到 SIGTERM 会停止认领、等待在途任务、释放租约后退出，
超过宽限期强制退出，容器一定停得掉。

看到 `启动：重型槽位 2 · 轻型槽位 6` 即正常。

可调参数：

```
WORKER_HEAVY_SLOTS=2      # 重型任务并发（方案/代码/报告）
WORKER_LIGHT_SLOTS=6      # 轻型任务并发
WORKER_POLL_MS=1500       # 空闲轮询间隔
```

**降级方案**：Worker 未就绪时可设 `ALLOW_INLINE_EXECUTE=1`，
退回前端点火的同步执行模式（不推荐用于比赛当天）。

## 3. 健康检查

| 端点 | 用途 | 鉴权 |
|---|---|---|
| `/api/health` | 存活探针，只答进程是否在跑 | 公开 |
| `/api/ready` | 就绪探针，检查数据库/迁移/模型链路 | 公开（详情需 admin） |
| `/api/routing-preview` | 当前选路与 mock 状态，零 token 消耗 | 公开 |

## 4. 压测

**先确认服务端处于 mock 模式**，否则会产生真实费用：

```bash
curl https://你的域名/api/routing-preview   # 确认 mock_enabled: true
BASE_URL=https://你的域名 ALLOW_MOCK_ASSUMED=1 npm run load-test -- --users 100 --ramp 20
```

只验队列链路（不调模型、几分钟完成）：

```bash
LOAD_MODE=queue-only LOAD_USERS=15 BASE_URL=... npm run load-test
```

## 5. 上线前必测

1. **并发隔离**：两个浏览器同时生成方案，在 `/admin/model-operations` 确认用量分别记到各自项目
2. **Worker 崩溃自愈**：`pm2 stop nuedc-worker` 杀掉正在跑的任务，90 秒后重启，任务应自动重新入队
3. **降级不白屏**：临时把 `SYSTEM_MODE=RULES_ONLY` 部署一次，确认页面提示清晰且项目编辑仍可用

## 6. Schema 版本与 Worker 兼容性

新版 Worker 遇到旧 schema 时的行为：

| 情况 | Worker 行为 |
|---|---|
| schema 完整 | 正常认领任务 |
| 缺列且 `WORKER_AUTO_MIGRATE=0`（默认） | 进入待命，每 30s 重查，**不执行任何 DDL** |
| 缺列且 `WORKER_AUTO_MIGRATE=1` | 自行补跑迁移后恢复 |

待命期间 Worker 仍会上报心跳（容量记为 0、`schema_waiting=true`），
因此 `/api/admin/readiness` 能区分「没有 Worker」与「Worker 在等 schema」。

**迁移 20 之前的库**：`worker_heartbeats` 尚无 `schema_waiting` / `auto_migrate` 两列，
心跳会自动回退到旧字段写入并记录 `heartbeat_legacy_schema` 指标 ——
此时仍能看到 Worker 存活与容量为 0，只是无法区分待命原因。
补跑迁移后 Worker 自动恢复完整上报，无需重启。

**推荐部署顺序**：先执行迁移，再滚动更新 Worker。

```bash
DATABASE_URL='...' npm run db:init     # 1. 迁移
# 2. 部署新版本 Web 与 Worker
```
