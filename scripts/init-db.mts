import { withTransaction } from "../lib/db";
import { ensureMigrations } from "../lib/migrations";

// 传 withTransaction：迁移的 advisory lock、DDL、记录写入必须在同一连接上
await ensureMigrations(withTransaction);
console.log("数据库迁移已应用（版本化 schema_migrations）");
