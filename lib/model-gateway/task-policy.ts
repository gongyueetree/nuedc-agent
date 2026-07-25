/** 每类任务的模型策略。降本的核心在这里：输出上限、thinking 预算、缓存、Provider 偏好。 */

export const TASK_TYPES = [
  "PDF_EXTRACT", "PROBLEM_STRUCTURE", "REQUIREMENT_NORMALIZE", "SCORING_EXTRACT",
  "SOLUTION_PRIMARY", "SOLUTION_FALLBACK", "BOM_NORMALIZE", "MODULE_GAP_ANALYSIS",
  "CODE_GENERATE", "CODE_REPAIR", "BUILD_LOG_EXPLAIN", "TEST_PLAN", "TEST_ANALYSIS",
  "DEBUG_ASSIST", "REPORT_SECTION", "REPORT_POLISH", "GENERAL_QA", "PROCUREMENT_PLAN", "MODULE_INGEST",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** 优先级：P0 最高。高峰期可暂停 P3。 */
export type Priority = 0 | 1 | 2 | 3;
export type CostClass = "low" | "medium" | "high";
export type Concurrency = "light" | "heavy";

/** Schema 校验强度：
 *  strict = 校验失败即判定调用失败（不缓存、不落正式产物）
 *  warn   = 记录 issues 但允许通过（供人工确认类任务）
 *  none   = 不校验（自由文本输出） */
export type SchemaMode = "strict" | "warn" | "none";

export interface TaskPolicy {
  taskType: TaskType;
  schemaMode: SchemaMode;
  /** 能力偏好：quality=优先强模型，cheap=优先低价模型，vision=需多模态 */
  preference: "quality" | "cheap" | "vision";
  useRulesFirst: boolean;
  allowCache: boolean;
  cacheScope: "global" | "project" | "none";
  maxInputTokens: number;
  maxOutputTokens: number;
  temperature: number;
  thinkingBudget: number;
  timeoutMs: number;
  maxRetries: number;
  costClass: CostClass;
  concurrencyClass: Concurrency;
  priority: Priority;
  requiresHumanReview: boolean;
}

const P = (
  taskType: TaskType, preference: TaskPolicy["preference"], maxOutputTokens: number,
  priority: Priority, over: Partial<TaskPolicy> = {},
): TaskPolicy => ({
  taskType, preference, maxOutputTokens, priority,
  schemaMode: "warn",
  useRulesFirst: false, allowCache: true, cacheScope: "project",
  maxInputTokens: 8000, temperature: 0.3, thinkingBudget: 0,
  timeoutMs: 90_000, maxRetries: 2,
  costClass: maxOutputTokens > 3000 ? "high" : maxOutputTokens > 1500 ? "medium" : "low",
  concurrencyClass: maxOutputTokens > 3000 ? "heavy" : "light",
  requiresHumanReview: false,
  ...over,
});

export const TASK_POLICIES: Record<TaskType, TaskPolicy> = {
  // ---- 赛题中心（官方题目只解析一次，结果全局缓存）----
  PDF_EXTRACT:           P("PDF_EXTRACT", "vision", 8000, 1, { cacheScope: "global", timeoutMs: 120_000, maxInputTokens: 20_000 }),
  PROBLEM_STRUCTURE:     P("PROBLEM_STRUCTURE", "quality", 4000, 1, { schemaMode: "strict", cacheScope: "global", requiresHumanReview: true }),
  SCORING_EXTRACT:       P("SCORING_EXTRACT", "quality", 2000, 1, { schemaMode: "strict", cacheScope: "global", requiresHumanReview: true }),

  // ---- 需求与方案 ----
  REQUIREMENT_NORMALIZE: P("REQUIREMENT_NORMALIZE", "cheap", 2000, 0, { schemaMode: "strict" }),
  SOLUTION_PRIMARY:      P("SOLUTION_PRIMARY", "quality", 4000, 0, { schemaMode: "strict", thinkingBudget: 1024, temperature: 0.4, timeoutMs: 120_000, requiresHumanReview: true }),
  SOLUTION_FALLBACK:     P("SOLUTION_FALLBACK", "cheap", 3000, 2, { schemaMode: "strict", temperature: 0.6, requiresHumanReview: true }),
  MODULE_GAP_ANALYSIS:   P("MODULE_GAP_ANALYSIS", "cheap", 1500, 1),

  // ---- 物料 ----
  BOM_NORMALIZE:         P("BOM_NORMALIZE", "cheap", 2000, 1, { schemaMode: "strict" }),
  PROCUREMENT_PLAN:      P("PROCUREMENT_PLAN", "cheap", 1500, 2),

  // ---- 代码 ----
  CODE_GENERATE:         P("CODE_GENERATE", "quality", 3000, 1, { schemaMode: "strict", timeoutMs: 120_000 }),
  CODE_REPAIR:           P("CODE_REPAIR", "quality", 3000, 0, { thinkingBudget: 1024, allowCache: false }),
  BUILD_LOG_EXPLAIN:     P("BUILD_LOG_EXPLAIN", "cheap", 1200, 2),

  // ---- 测试与调试 ----
  TEST_PLAN:             P("TEST_PLAN", "cheap", 2500, 1, { schemaMode: "strict" }),
  TEST_ANALYSIS:         P("TEST_ANALYSIS", "cheap", 1500, 0),
  DEBUG_ASSIST:          P("DEBUG_ASSIST", "quality", 1500, 0, { thinkingBudget: 512, allowCache: false }),

  // ---- 报告 ----
  REPORT_SECTION:        P("REPORT_SECTION", "cheap", 2500, 2),
  REPORT_POLISH:         P("REPORT_POLISH", "cheap", 1200, 3, { temperature: 0.5 }),

  // ---- 其他 ----
  GENERAL_QA:            P("GENERAL_QA", "cheap", 1500, 3, { cacheScope: "global" }),

  // 附件导入：多模态、结果必须人工确认
  MODULE_INGEST:         P("MODULE_INGEST", "vision", 3000, 2, {
    schemaMode: "strict", cacheScope: "global", requiresHumanReview: true,
    timeoutMs: 120_000, maxInputTokens: 20_000,
  }),
};

export function policyFor(taskType: TaskType): TaskPolicy {
  return TASK_POLICIES[taskType] || TASK_POLICIES.GENERAL_QA;
}

/** Agent 名 → taskType 映射（迁移期用，Agent 未显式声明时的兜底） */
export const AGENT_TASK_TYPE: Record<string, TaskType> = {
  problem_interpreter: "PROBLEM_STRUCTURE",
  topic_forecast: "GENERAL_QA",
  module_knowledge: "MODULE_GAP_ANALYSIS",
  solution_architect: "SOLUTION_PRIMARY",
  bom_agent: "BOM_NORMALIZE",
  procurement_planner: "PROCUREMENT_PLAN",
  code_generator: "CODE_GENERATE",
  labsight_debug: "DEBUG_ASSIST",
  report_composer: "REPORT_SECTION",
  orchestrator: "GENERAL_QA",
  test_scoring: "TEST_PLAN",
  module_ingestion: "MODULE_INGEST",
};
