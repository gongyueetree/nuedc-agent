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
    // 延迟 require：Vercel 环境不需要 pg，避免打包体积与冷启动开销
    const { Pool } = require("pg");
    _client = new Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // 自建/CI 的本地库通常无 TLS；云托管一般要求 TLS
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

/** 在事务中执行一组语句。
 *  postgres_pool 用真事务（单连接 BEGIN/COMMIT/ROLLBACK）。
 *  neon HTTP 驱动无法做「依赖前一条结果的条件事务」——其 transaction API 只接受
 *  预构建语句数组。此时降级为顺序执行，正确性由调用方保证：
 *  状态转换用条件 UPDATE 保证只成功一次，配额结算函数本身幂等，
 *  因此顺序执行不会产生重复结算。 */
export async function withTransaction<T>(fn: (tx: { execute: (s: Stmt) => Promise<{ rows: any[] }> }) => Promise<T>): Promise<T> {
  const { driver, client } = conn();

  if (driver !== "postgres_pool") {
    return fn(db());   // neon：降级为顺序执行（见上方说明）
  }

  const c = await client.connect();
  const tx = {
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

/** 当前使用的驱动（诊断与 /api/ready 用） */
export function dbDriver(): string {
  try { return conn().driver; } catch { return "unconfigured"; }
}

/** 优雅关闭连接池（Worker 退出时调用；Neon HTTP 驱动无需关闭） */
export async function closeDb(): Promise<void> {
  if (_driver === "postgres_pool" && _client?.end) {
    await _client.end().catch(() => {});
  }
  _client = null;
  _driver = null;
}

import { ensureMigrations } from "./migrations";

export { SCHEMA_SQL } from "./schema-sql";

export async function ensureSchema() {
  // 静态导入：动态 import 在 data-URL 入口下无法解析相对路径
  await ensureMigrations(db());
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
