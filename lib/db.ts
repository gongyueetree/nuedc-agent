import { neon } from "@neondatabase/serverless";

/**
 * Postgres 数据层，支持两种驱动：
 *  - neon（默认）：Neon Serverless HTTP 驱动，用于 Vercel 等无常驻连接的环境
 *  - postgres_pool：标准 node-postgres 连接池，用于自建服务器、Docker、CI 的普通 Postgres
 *
 * 驱动选择顺序：DB_DRIVER 显式指定 > 按连接串主机名自动判断（*.neon.tech → neon）。
 * 对外统一接口：db().execute(sql | { sql, args }) → { rows }
 * `?` 占位符在此处自动转换为 Postgres 的 $1..$n，上层调用点无需改动。
 */

type Stmt = string | { sql: string; args?: unknown[] };
type Driver = "neon" | "postgres_pool";

let _client: any = null;
let _driver: Driver | null = null;

function pickDriver(url: string): Driver {
  const explicit = process.env.DB_DRIVER;
  if (explicit === "neon" || explicit === "postgres_pool") return explicit;
  try {
    const host = new URL(url).hostname;
    // Neon 的 HTTP 驱动只认自家域名；其余一律走标准连接池
    return /\.neon\.tech$/i.test(host) ? "neon" : "postgres_pool";
  } catch {
    return "neon";
  }
}

function conn(): { driver: Driver; client: any } {
  if (_client && _driver) return { driver: _driver, client: _client };
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "缺少 DATABASE_URL。请在 Neon 控制台复制连接串（postgresql://...），本地写入 .env.local，线上配置到 Vercel 环境变量。"
    );
  }
  _driver = pickDriver(url);
  if (_driver === "neon") {
    _client = neon(url);
  } else {
    const { Pool } = require("pg");   // 延迟 require：Vercel 上普通查询走 neon HTTP，无需打包 pg
    _client = new Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
    });
  }
  return { driver: _driver, client: _client };
}

function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export function db() {
  return {
    async execute(stmt: Stmt): Promise<{ rows: Record<string, unknown>[] }> {
      const s = typeof stmt === "string" ? { sql: stmt, args: [] as unknown[] } : stmt;
      const { client } = conn();
      const rows = await client.query(toPgPlaceholders(s.sql), (s.args ?? []) as unknown[]);
      return { rows: (Array.isArray(rows) ? rows : (rows?.rows ?? [])) as Record<string, unknown>[] };
    },
  };
}

/** 事务执行器。与 db().execute 同接口，但绑定在同一条有状态连接上。 */
export interface TxExecutor {
  execute: (stmt: Stmt) => Promise<{ rows: any[] }>;
}

export class TransactionDriverUnavailableError extends Error {
  readonly code = "TRANSACTION_DRIVER_UNAVAILABLE";
  constructor(detail: string) {
    super(`无可用的事务驱动：${detail}。任务状态与配额结算必须在同一事务内完成，` +
          `拒绝以顺序独立查询降级执行。`);
    this.name = "TransactionDriverUnavailableError";
  }
}

/** 事务专用连接池。与 db() 的 HTTP 驱动分开：
 *  neon HTTP（无状态）无法执行 BEGIN/COMMIT/ROLLBACK，
 *  因此事务必须走有状态连接。 */
let _txPool: any = null;
let _txPoolKind: "neon_ws" | "pg" | null = null;

function txPool(): { pool: any; kind: string } {
  if (_txPool && _txPoolKind) return { pool: _txPool, kind: _txPoolKind };

  const url = process.env.DATABASE_URL;
  if (!url) throw new TransactionDriverUnavailableError("未配置 DATABASE_URL");

  const isNeon = (() => {
    try { return /\.neon\.tech$/i.test(new URL(url).hostname); } catch { return false; }
  })();

  // Neon：优先用官方 serverless Pool（WebSocket，serverless 环境更快）
  if (isNeon) {
    try {
      const { Pool: NeonPool, neonConfig } = require("@neondatabase/serverless");
      // Node 20 无全局 WebSocket，需显式注入构造器
      if (!neonConfig.webSocketConstructor) {
        if (typeof globalThis.WebSocket === "function") {
          neonConfig.webSocketConstructor = globalThis.WebSocket;
        } else {
          try { neonConfig.webSocketConstructor = require("ws"); } catch { /* 落到 pg 分支 */ }
        }
      }
      if (neonConfig.webSocketConstructor) {
        _txPool = new NeonPool({ connectionString: url, max: Number(process.env.PG_POOL_MAX || 5) });
        _txPoolKind = "neon_ws";
        return { pool: _txPool, kind: _txPoolKind };
      }
    } catch { /* 继续尝试 pg */ }
  }

  // 标准 Postgres 协议（Neon 同样支持），作为通用事务通道
  try {
    const { Pool } = require("pg");
    _txPool = new Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: isNeon || /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
    });
    _txPoolKind = "pg";
    return { pool: _txPool, kind: _txPoolKind };
  } catch (e: any) {
    throw new TransactionDriverUnavailableError(
      `neon WebSocket 与 pg 均不可用（${String(e?.message || e).slice(0, 120)}）`);
  }
}

/** 在真实数据库事务中执行。
 *
 *  绝不降级为顺序独立查询：状态转换与配额结算必须同生共死，
 *  否则进程在两者之间崩溃会留下「任务已终态但配额未结算」的不一致。
 *  无可用事务驱动时抛 TRANSACTION_DRIVER_UNAVAILABLE，由调用方决定如何处理。 */
export async function withTransaction<T>(fn: (tx: TxExecutor) => Promise<T>): Promise<T> {
  const { pool } = txPool();
  const c = await pool.connect();
  const tx: TxExecutor = {
    async execute(stmt: Stmt) {
      const s = typeof stmt === "string" ? { sql: stmt, args: [] as unknown[] } : stmt;
      const r = await c.query(toPgPlaceholders(s.sql), (s.args ?? []) as unknown[]);
      return { rows: (r?.rows ?? []) as any[] };
    },
  };
  try {
    await c.query("BEGIN");
    const out = await fn(tx);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** 事务驱动可用性（/api/admin/readiness 用） */
export function txDriverKind(): string {
  try { return txPool().kind; } catch { return "unavailable"; }
}

/** 当前使用的驱动（诊断与 /api/ready 用） *//** 当前使用的驱动（诊断与 /api/ready 用） */
export function dbDriver(): string {
  try { return conn().driver; } catch { return "unconfigured"; }
}

/** 优雅关闭连接池（Worker 退出时调用；Neon HTTP 驱动无需关闭） */
export async function closeDb(): Promise<void> {
  if (_driver === "postgres_pool" && _client?.end) {
    await _client.end().catch(() => {});
  }
  if (_txPool?.end) await _txPool.end().catch(() => {});
  _client = null;
  _driver = null;
  _txPool = null;
  _txPoolKind = null;
}

import { ensureMigrations } from "./migrations";

export { SCHEMA_SQL } from "./schema-sql";

export async function ensureSchema(opts: { force?: boolean } = {}) {
  // 静态导入：动态 import 在 data-URL 入口下无法解析相对路径
  await ensureMigrations(db(), opts);
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
