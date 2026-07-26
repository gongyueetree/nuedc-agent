import { SCHEMA_SQL } from "./schema-sql";

/** 数据库执行器由调用方注入，避免 migrations ↔ db 循环依赖。
 *  循环依赖在 data-URL 入口（node --import tsx -e）下会导致模块初始化顺序错乱。 */
type Executor = { execute: (q: string | { sql: string; args?: unknown[] }) => Promise<{ rows: any[] }> };

/** 版本化数据库迁移（诊断 5.4）。
 *  - 每个迁移一个编号，执行过的记录在 schema_migrations 表
 *  - `npm run db:init` 与运行时 ensureMigrations() 都只补跑缺失的迁移
 *  - 修改表结构：追加新迁移，禁止改动已发布的旧迁移 */

export interface Migration { id: number; name: string; sql: string }

export const MIGRATIONS: Migration[] = [
  { id: 1, name: "base_schema", sql: SCHEMA_SQL },
  {
    id: 2,
    name: "agent_runs_model_and_project_owner",
    sql: `
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS error TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner TEXT;
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner);
`,
  },
  {
    id: 3,
    name: "module_revisions",
    sql: `
CREATE TABLE IF NOT EXISTS module_revisions (
  revision_id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL,
  revision_code TEXT NOT NULL,
  identified_chip TEXT,
  changes TEXT,
  source_note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_revisions_module ON module_revisions(module_id);
`,
  },
  {
    id: 4,
    name: "build_jobs",
    sql: `
CREATE TABLE IF NOT EXISTS build_jobs (
  job_id TEXT PRIMARY KEY,
  project_id TEXT,
  target TEXT NOT NULL,
  status TEXT DEFAULT 'queued',
  files TEXT NOT NULL,
  log TEXT,
  flash_bytes INTEGER,
  ram_bytes INTEGER,
  elf_b64 TEXT,
  bin_b64 TEXT,
  claimed_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_build_project ON build_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_build_status ON build_jobs(status);
`,
  },
  {
    id: 5,
    name: "legacy_projects_to_admin",
    sql: `
UPDATE projects SET owner='admin:legacy' WHERE owner IS NULL;
`,
  },
  {
    id: 6,
    name: "agent_tasks",
    sql: `
CREATE TABLE IF NOT EXISTS agent_tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT,
  agent_type TEXT NOT NULL,
  status TEXT DEFAULT 'queued',
  input TEXT,
  output TEXT,
  error TEXT,
  tier TEXT DEFAULT 'free',
  idempotency_key TEXT,
  attempts INTEGER DEFAULT 0,
  cancel_requested INTEGER DEFAULT 0,
  last_run_id TEXT,
  model TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON agent_tasks(project_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idem ON agent_tasks(idempotency_key) WHERE idempotency_key IS NOT NULL;
`,
  },
  {
    id: 7,
    name: "artifact_provenance_snapshots_members_task_policy",
    sql: `
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS source_artifact_ids TEXT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS schema_version INTEGER DEFAULT 1;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS change_reason TEXT;
CREATE TABLE IF NOT EXISTS artifact_dependencies (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT,
  artifact_id TEXT NOT NULL,
  source_artifact_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deps_artifact ON artifact_dependencies(artifact_id);
CREATE INDEX IF NOT EXISTS idx_deps_source ON artifact_dependencies(source_artifact_id);
CREATE TABLE IF NOT EXISTS project_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT,
  manifest TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_snapshots_project ON project_snapshots(project_id);
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL,
  user_ref TEXT NOT NULL,
  role TEXT DEFAULT 'member',
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (project_id, user_ref)
);
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 5;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS max_attempts INTEGER DEFAULT 3;
`,
  },
  {
    id: 8,
    name: "llm_usage_tracking",
    sql: `
CREATE TABLE IF NOT EXISTS llm_usage (
  id BIGSERIAL PRIMARY KEY,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_usage_owner_kind ON llm_usage(owner, kind, created_at);
`,
  },
  {
    id: 9,
    name: "project_notes_and_archive",
    sql: `
ALTER TABLE projects ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived INTEGER DEFAULT 0;
`,
  },
  {
    id: 10,
    name: "entitlements_quota_counters_access_codes",
    sql: `
CREATE TABLE IF NOT EXISTS user_entitlements (
  id BIGSERIAL PRIMARY KEY,
  owner TEXT NOT NULL,
  tier TEXT NOT NULL,
  source TEXT,
  granted_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_entitlements_owner ON user_entitlements(owner, revoked_at);

CREATE TABLE IF NOT EXISTS quota_counters (
  owner TEXT NOT NULL,
  kind TEXT NOT NULL,
  day DATE NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, kind, day)
);

CREATE TABLE IF NOT EXISTS access_codes (
  code_hash TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'paid',
  max_uses INTEGER DEFAULT 1,
  used_count INTEGER DEFAULT 0,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS redeem_attempts (
  id BIGSERIAL PRIMARY KEY,
  owner TEXT NOT NULL,
  ok INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attempts_owner ON redeem_attempts(owner, created_at);

CREATE TABLE IF NOT EXISTS health_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'success';
ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS ref TEXT;
`,
  },
  {
    id: 11,
    name: "model_gateway_telemetry_and_scheduling",
    sql: `
CREATE TABLE IF NOT EXISTS llm_usage_events (
  id BIGSERIAL PRIMARY KEY,
  owner TEXT,
  project_id TEXT,
  task_id TEXT,
  task_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  estimated_cost NUMERIC(12,6) DEFAULT 0,
  latency_ms INTEGER DEFAULT 0,
  status TEXT NOT NULL,
  error_code TEXT,
  fallback_used INTEGER DEFAULT 0,
  cache_hit INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_owner_day ON llm_usage_events(owner, created_at);
CREATE INDEX IF NOT EXISTS idx_events_provider ON llm_usage_events(provider, created_at);
CREATE INDEX IF NOT EXISTS idx_events_project ON llm_usage_events(project_id, created_at);

CREATE TABLE IF NOT EXISTS provider_health (
  provider TEXT PRIMARY KEY,
  status TEXT DEFAULT 'healthy',
  consecutive_429 INTEGER DEFAULT 0,
  disabled_until TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_cache (
  cache_key TEXT PRIMARY KEY,
  task_type TEXT NOT NULL,
  scope TEXT DEFAULT 'project',
  output TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  hit_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cache_expiry ON model_cache(expires_at);

CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS task_type TEXT;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS owner_ref TEXT;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS queue_name TEXT DEFAULT 'default';
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS provider_hint TEXT;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS input_hash TEXT;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS timeout_at TIMESTAMPTZ;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS fallback_count INTEGER DEFAULT 0;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS token_input INTEGER DEFAULT 0;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS token_output INTEGER DEFAULT 0;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC(12,6) DEFAULT 0;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS error_code TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_queue ON agent_tasks(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_hash ON agent_tasks(input_hash) WHERE input_hash IS NOT NULL;
`,
  },
  {
    id: 12,
    name: "problem_center",
    sql: `
CREATE TABLE IF NOT EXISTS official_problems (
  problem_id TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  group_name TEXT,
  status TEXT DEFAULT 'draft',
  problem_version INTEGER DEFAULT 1,
  source_pdf_hash TEXT,
  raw_text TEXT,
  requirements TEXT,
  scoring_items TEXT,
  notes TEXT,
  report_requirements TEXT,
  created_by TEXT,
  published_by TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_problems_year ON official_problems(year, code);
CREATE INDEX IF NOT EXISTS idx_problems_status ON official_problems(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_problems_pdf ON official_problems(source_pdf_hash) WHERE source_pdf_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS problem_review_diffs (
  id BIGSERIAL PRIMARY KEY,
  problem_id TEXT NOT NULL,
  field_path TEXT NOT NULL,
  provider_a TEXT,
  provider_b TEXT,
  value_a TEXT,
  value_b TEXT,
  severity TEXT DEFAULT 'info',
  resolved INTEGER DEFAULT 0,
  resolution TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_diffs_problem ON problem_review_diffs(problem_id, resolved);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS problem_id TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS problem_version INTEGER;
`,
  },
  {
    id: 13,
    name: "worker_lease_and_quota_binding",
    sql: `
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS worker_id TEXT;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS quota_ref TEXT;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS quota_kind TEXT;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS dead_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_claim ON agent_tasks(priority, scheduled_at) WHERE status='queued';
CREATE INDEX IF NOT EXISTS idx_tasks_lease ON agent_tasks(lease_expires_at) WHERE status='running';
`,
  },
  {
    id: 14,
    name: "problem_center_normalized",
    sql: `
CREATE TABLE IF NOT EXISTS problem_versions (
  version_id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  status TEXT DEFAULT 'draft',
  content_hash TEXT,
  source_pdf_sha256 TEXT,
  raw_text TEXT,
  published_by TEXT,
  published_at TIMESTAMPTZ,
  immutable INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (problem_id, version_no)
);
CREATE INDEX IF NOT EXISTS idx_pv_problem ON problem_versions(problem_id, version_no DESC);
CREATE INDEX IF NOT EXISTS idx_pv_pdf ON problem_versions(source_pdf_sha256);

CREATE TABLE IF NOT EXISTS problem_requirements (
  req_id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL,
  requirement_no TEXT NOT NULL,
  type TEXT,
  description TEXT NOT NULL,
  target TEXT,
  unit TEXT,
  tolerance TEXT,
  priority TEXT,
  verification_method TEXT,
  source_page INTEGER,
  source_quote TEXT,
  status TEXT DEFAULT 'AI_EXTRACTED',
  confirmed_by TEXT,
  confirmed_at TIMESTAMPTZ,
  sort_order INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_preq_version ON problem_requirements(version_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_preq_no ON problem_requirements(version_id, requirement_no);

CREATE TABLE IF NOT EXISTS problem_scoring_items (
  item_id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL,
  item TEXT NOT NULL,
  points NUMERIC(8,2),
  points_type TEXT DEFAULT 'estimated',
  requirement_refs TEXT,
  source_page INTEGER,
  source_quote TEXT,
  sort_order INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_psi_version ON problem_scoring_items(version_id, sort_order);

CREATE TABLE IF NOT EXISTS problem_notes (
  note_id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  resolved INTEGER DEFAULT 0,
  resolution TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pnote_version ON problem_notes(version_id, kind);

CREATE TABLE IF NOT EXISTS problem_reviews (
  review_id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  decision TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_preview_version ON problem_reviews(version_id);

ALTER TABLE problem_review_diffs ADD COLUMN IF NOT EXISTS version_id TEXT;
ALTER TABLE problem_review_diffs ADD COLUMN IF NOT EXISTS requirement_no TEXT;
ALTER TABLE problem_review_diffs ADD COLUMN IF NOT EXISTS match_method TEXT;
ALTER TABLE problem_review_diffs ADD COLUMN IF NOT EXISTS match_confidence NUMERIC(4,3);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS problem_version_id TEXT;
`,
  },
  {
    id: 15,
    name: "module_scope_and_inventory",
    sql: `
ALTER TABLE modules ADD COLUMN IF NOT EXISTS scope TEXT DEFAULT 'PUBLIC';
ALTER TABLE modules ADD COLUMN IF NOT EXISTS owner_ref TEXT;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS org_ref TEXT;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS inventory_qty INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_modules_scope ON modules(scope, certification_status);
`,
  },
  {
    id: 16,
    name: "org_module_scope_api",
    sql: `
UPDATE modules SET scope='PUBLIC' WHERE scope IS NULL;
CREATE INDEX IF NOT EXISTS idx_modules_org ON modules(org_ref) WHERE org_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_modules_owner ON modules(owner_ref) WHERE owner_ref IS NOT NULL;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS org_ref TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_org ON agent_tasks(org_ref, created_at);
`,
  },
  {
    id: 17,
    name: "worker_heartbeats",
    sql: `
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ DEFAULT now(),
  last_seen TIMESTAMPTZ DEFAULT now(),
  heavy_slots INTEGER DEFAULT 0,
  light_slots INTEGER DEFAULT 0,
  in_flight INTEGER DEFAULT 0,
  driver TEXT,
  version TEXT
);
CREATE INDEX IF NOT EXISTS idx_worker_seen ON worker_heartbeats(last_seen DESC);
`,
  },
  {
    id: 18,
    name: "module_suggested_id_and_worker_metrics",
    sql: `
ALTER TABLE modules ADD COLUMN IF NOT EXISTS suggested_id TEXT;
CREATE INDEX IF NOT EXISTS idx_modules_suggested ON modules(suggested_id) WHERE suggested_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS worker_metrics (
  worker_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (worker_id, metric)
);
`,
  },
];

let applied = false;

export async function ensureMigrations(exec: Executor): Promise<void> {
  if (applied) return;
  const c = exec;
  await c.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT, applied_at TIMESTAMPTZ DEFAULT now()
  )`);
  const rs = await c.execute("SELECT id FROM schema_migrations");
  const done = new Set(rs.rows.map((r) => Number(r.id)));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    for (const stmt of m.sql.split(";").map((s) => s.trim()).filter(Boolean)) {
      await c.execute(stmt);
    }
    await c.execute({ sql: "INSERT INTO schema_migrations (id, name) VALUES (?, ?)", args: [m.id, m.name] });
  }
  applied = true;
}
