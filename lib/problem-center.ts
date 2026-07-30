import { createHash } from "node:crypto";
import { db, ensureSchema, uid, withTransaction } from "./db";
import { normalizeTarget } from "./requirement-validate";
import { parseOptions, parseDecision, type Ambiguity } from "./ambiguity";
import { parseTags, suggestTechTags, type ContestType, type TechCategory } from "./problem-taxonomy";

/** 赛题中心（规范化模型）。
 *  official_problems 只存题目主体；每次发布产生不可变的 problem_versions，
 *  需求/评分项/说明/审核记录各自成表，可按条查询、确认与追溯。 */

export const PROBLEM_STATUSES = ["draft", "extracted", "reviewing", "published", "archived"] as const;
export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

/** 对完整 PDF 二进制计算 SHA-256。
 *  绝不能只取前缀：赛题 PDF 往往共用模板，前若干字节高度相似，
 *  截断哈希会把不同题目误判为同一份。 */
export function pdfSha256(base64: string): string {
  return createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
}

/* ============ 题目与版本 ============ */

export async function createProblem(input: {
  year: number; code: string; title: string; groupName?: string; createdBy: string;
  contestType?: ContestType; region?: string; techTags?: TechCategory[]; sourceUrl?: string;
}): Promise<string> {
  await ensureSchema();
  const id = uid("PROB");
  // 未指定技术方向时给出建议值，仍需工程师在后台确认
  const tags = input.techTags?.length ? input.techTags : suggestTechTags(input.title);
  await db().execute({
    sql: `INSERT INTO official_problems (problem_id, year, code, title, group_name, status, created_by,
            contest_type, region, tech_tags, source_url)
          VALUES (?,?,?,?,?, 'draft', ?,?,?,?,?)`,
    args: [id, input.year, String(input.code).toUpperCase(), input.title, input.groupName || null,
      input.createdBy, input.contestType || "national", input.region || null,
      JSON.stringify(tags), input.sourceUrl || null],
  });
  return id;
}

/** 更新分类标记（工程师在后台确认时调用） */
export async function updateTaxonomy(problemId: string, input: {
  contestType?: ContestType; region?: string; techTags?: TechCategory[]; difficulty?: string;
}): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: any[] = [];
  if (input.contestType) { sets.push("contest_type=?"); args.push(input.contestType); }
  if (input.region !== undefined) { sets.push("region=?"); args.push(input.region || null); }
  if (input.techTags) { sets.push("tech_tags=?"); args.push(JSON.stringify(input.techTags)); }
  if (input.difficulty !== undefined) { sets.push("difficulty=?"); args.push(input.difficulty || null); }
  if (!sets.length) return;
  sets.push("updated_at=now()");
  await db().execute({
    sql: `UPDATE official_problems SET ${sets.join(", ")} WHERE problem_id=?`,
    args: [...args, problemId],
  });
}

/** 创建可编辑的草稿版本（已发布版本不可改，修订必须开新版本） */
export async function createDraftVersion(problemId: string, opts: { rawText?: string; pdfSha?: string } = {}): Promise<string> {
  await ensureSchema();
  const rs = await db().execute({
    sql: "SELECT COALESCE(MAX(version_no), 0) v FROM problem_versions WHERE problem_id=?",
    args: [problemId],
  });
  const next = Number(rs.rows[0]?.v || 0) + 1;
  const vid = uid("PVER");
  await db().execute({
    sql: `INSERT INTO problem_versions (version_id, problem_id, version_no, status, raw_text, source_pdf_sha256, immutable)
          VALUES (?,?,?, 'draft', ?, ?, 0)`,
    args: [vid, problemId, next, opts.rawText || null, opts.pdfSha || null],
  });
  return vid;
}

/** 按 PDF 哈希查已有版本（同一份 PDF 不重复解析） */
export async function findVersionByPdf(sha: string) {
  await ensureSchema();
  const rs = await db().execute({
    sql: `SELECT v.version_id, v.problem_id, v.version_no, v.status, p.title, p.year, p.code
          FROM problem_versions v JOIN official_problems p ON p.problem_id = v.problem_id
          WHERE v.source_pdf_sha256=? ORDER BY v.version_no DESC LIMIT 1`,
    args: [sha],
  });
  return rs.rows[0] || null;
}

export async function getDraftVersion(problemId: string) {
  await ensureSchema();
  const rs = await db().execute({
    sql: `SELECT version_id, version_no, status, raw_text FROM problem_versions
          WHERE problem_id=? AND status != 'published' ORDER BY version_no DESC LIMIT 1`,
    args: [problemId],
  });
  return rs.rows[0] || null;
}

export async function getPublishedVersion(problemId: string) {
  await ensureSchema();
  const rs = await db().execute({
    sql: `SELECT version_id, version_no, published_at FROM problem_versions
          WHERE problem_id=? AND status='published' ORDER BY version_no DESC LIMIT 1`,
    args: [problemId],
  });
  return rs.rows[0] || null;
}

/** 读取某版本的完整内容 */
export async function getVersionContent(versionId: string) {
  await ensureSchema();
  const [ver, reqs, items, notes, reviews] = await Promise.all([
    db().execute({
      sql: `SELECT v.*, p.year, p.code, p.title, p.group_name FROM problem_versions v
            JOIN official_problems p ON p.problem_id=v.problem_id WHERE v.version_id=?`, args: [versionId] }),
    db().execute({ sql: "SELECT * FROM problem_requirements WHERE version_id=? ORDER BY sort_order, requirement_no", args: [versionId] }),
    db().execute({ sql: "SELECT * FROM problem_scoring_items WHERE version_id=? ORDER BY sort_order", args: [versionId] }),
    db().execute({ sql: "SELECT * FROM problem_notes WHERE version_id=? ORDER BY created_at", args: [versionId] }),
    db().execute({ sql: "SELECT * FROM problem_reviews WHERE version_id=? ORDER BY created_at", args: [versionId] }),
  ]);
  if (!ver.rows.length) return null;
  return {
    version: ver.rows[0] as any,
    requirements: (reqs.rows as any[]).map((r) => ({ ...r, id: r.requirement_no })),
    scoring_items: (items.rows as any[]).map((r) => ({
      ...r,
      requirement_ids: (() => { try { return JSON.parse(String(r.requirement_refs || "[]")); } catch { return []; } })(),
    })),
    notes: notes.rows as any[],
    reviews: reviews.rows as any[],
  };
}

/** 写入提取结果（仅草稿版本可写） */
export async function saveExtraction(versionId: string, data: {
  requirements?: any[]; scoringItems?: any[]; ambiguities?: any[]; rawText?: string;
}) {
  await ensureSchema();
  const v = await db().execute({ sql: "SELECT immutable, status FROM problem_versions WHERE version_id=?", args: [versionId] });
  if (!v.rows.length) throw new Error("版本不存在");
  if (Number((v.rows[0] as any).immutable) === 1 || String((v.rows[0] as any).status) === "published") {
    throw new Error("已发布版本不可修改，请创建新版本后再编辑");
  }

  if (data.rawText !== undefined) {
    await db().execute({ sql: "UPDATE problem_versions SET raw_text=? WHERE version_id=?", args: [data.rawText, versionId] });
  }
  if (data.requirements) {
    await db().execute({ sql: "DELETE FROM problem_requirements WHERE version_id=?", args: [versionId] });
    // requirement_no 上有唯一索引 idx_preq_no。模型在同一次输出里可能给出
    // 重复或空的编号（实测 2025 A 题即因此整题失败），这里去重补号。
    const seen = new Set<string>();
    let i = 0;
    for (const r of data.requirements) {
      i++;
      let no = String(r.id || r.requirement_no || "").trim() || `REQ-${String(i).padStart(3, "0")}`;
      if (seen.has(no)) {
        let n = 2;
        while (seen.has(`${no}-${n}`)) n++;
        no = `${no}-${n}`;
      }
      seen.add(no);
      // 入库前规范化：模型常把单位写进 target（"1Hz~1MHz" + unit "Hz"），
      // 显示层再拼一次就成了 "1Hz~1MHzHz"，并会一路污染方案/BOM/报告
      const nt = normalizeTarget(r);
      await db().execute({
        sql: `INSERT INTO problem_requirements (req_id, version_id, requirement_no, type, description, target, unit,
                tolerance, priority, verification_method, source_page, source_quote, status, sort_order)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [uid("PRQ"), versionId, no,
          r.type || null, r.description || "", nt.target, nt.unit,
          nt.tolerance, r.priority || "mandatory", r.verification_method || null,
          r.source_page != null ? Number(r.source_page) : null, r.source_quote || r.source || null,
          r.status || "AI_EXTRACTED", i],
      });
    }
  }
  if (data.scoringItems) {
    await db().execute({ sql: "DELETE FROM problem_scoring_items WHERE version_id=?", args: [versionId] });
    let i = 0;
    for (const s of data.scoringItems) {
      i++;
      await db().execute({
        sql: `INSERT INTO problem_scoring_items (item_id, version_id, item, points, points_type,
                requirement_refs, source_page, source_quote, sort_order)
              VALUES (?,?,?,?,?,?,?,?,?)`,
        args: [uid("PSI"), versionId, s.item || "", s.points != null ? Number(s.points) : null,
          s.points_type || "estimated", JSON.stringify(s.requirement_ids || []),
          s.source_page != null ? Number(s.source_page) : null, s.source_quote || null, i],
      });
    }
  }
  if (data.ambiguities) {
    await db().execute({ sql: "DELETE FROM problem_notes WHERE version_id=? AND kind='ambiguity'", args: [versionId] });
    for (const a of data.ambiguities) {
      const text = typeof a === "string" ? a : (a?.description || a?.content || JSON.stringify(a));
      // 候选解释与严重度：让工作人员能直接选 A/B 而不是自己想
      const opts = typeof a === "object" ? parseOptions(a?.options) : [];
      // 涉及指标数值、误差要求、测量对象的歧义会直接影响方案与评分，标为 critical
      const isCritical = typeof a === "object" && a?.severity === "critical"
        ? true
        : /误差|精度|范围|多少|未给出|未明确|单路还是|哪一?个|是否/.test(String(text));
      await db().execute({
        sql: `INSERT INTO problem_notes (note_id, version_id, kind, content, options, severity)
              VALUES (?,?,'ambiguity',?,?,?)`,
        args: [uid("PN"), versionId, String(text).slice(0, 1000),
          opts.length ? JSON.stringify(opts) : null,
          isCritical ? "critical" : "normal"],
      });
    }
  }
  await db().execute({ sql: "UPDATE problem_versions SET status='extracted' WHERE version_id=? AND status='draft'", args: [versionId] });
}

/* ============ 双模复核差异匹配 ============ */

const norm = (s: any) => String(s ?? "").replace(/\s+/g, "").toLowerCase();

/** 字符二元组 Dice 相似度：对中文短句效果好且计算快 */
export function similarity(a: string, b: string): number {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bigrams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  const bx = bigrams(x), by = bigrams(y);
  let inter = 0;
  for (const [g, n] of bx) inter += Math.min(n, by.get(g) || 0);
  const total = (x.length - 1) + (y.length - 1);
  return total > 0 ? (2 * inter) / total : 0;
}

export interface MatchedPair {
  a: any | null;
  b: any | null;
  method: "requirement_no" | "source_page" | "source_quote" | "unmatched";
  confidence: number;
}

/** 多策略配对：编号 → 页码+描述 → 原文相似度 → 未匹配。
 *  绝不按数组下标对齐 —— 一方多提取一条会导致后续全部错位、产生大量假差异。 */
export function matchRequirements(listA: any[], listB: any[]): MatchedPair[] {
  const pairs: MatchedPair[] = [];
  const usedB = new Set<number>();
  const idOf = (r: any) => r?.id || r?.requirement_no;
  const quoteOf = (r: any) => r?.source_quote || r?.source || "";

  for (const a of listA) {
    let idx = listB.findIndex((b, i) => !usedB.has(i) && idOf(b) && idOf(a) && norm(idOf(b)) === norm(idOf(a)));
    if (idx >= 0) { usedB.add(idx); pairs.push({ a, b: listB[idx], method: "requirement_no", confidence: 1 }); continue; }

    const samePage = listB
      .map((b, i) => ({ b, i }))
      .filter(({ b, i }) => !usedB.has(i) && a.source_page != null && b.source_page != null
        && Number(a.source_page) === Number(b.source_page));
    if (samePage.length) {
      const best = samePage
        .map(({ b, i }) => ({ i, b, s: similarity(a.description, b.description) }))
        .sort((x, y) => y.s - x.s)[0];
      if (best && best.s >= 0.5) {
        usedB.add(best.i);
        pairs.push({ a, b: best.b, method: "source_page", confidence: best.s });
        continue;
      }
    }

    const byQuote = listB
      .map((b, i) => ({ b, i, s: Math.max(similarity(quoteOf(a), quoteOf(b)), similarity(a.description, b.description)) }))
      .filter(({ i }) => !usedB.has(i))
      .sort((x, y) => y.s - x.s)[0];
    if (byQuote && byQuote.s >= 0.6) {
      usedB.add(byQuote.i);
      pairs.push({ a, b: byQuote.b, method: "source_quote", confidence: byQuote.s });
      continue;
    }

    pairs.push({ a, b: null, method: "unmatched", confidence: 0 });
  }

  listB.forEach((b, i) => {
    if (!usedB.has(i)) pairs.push({ a: null, b, method: "unmatched", confidence: 0 });
  });
  return pairs;
}

export interface Diff {
  field_path: string; requirement_no?: string | null;
  value_a: string; value_b: string; severity: "critical" | "warning" | "info";
  match_method: string; match_confidence: number;
}

export function diffExtractions(
  a: { requirements: any[]; scoring_items: any[] },
  b: { requirements: any[]; scoring_items: any[] },
): Diff[] {
  const diffs: Diff[] = [];
  const pairs = matchRequirements(a.requirements || [], b.requirements || []);

  for (const p of pairs) {
    const no = (p.a?.id || p.a?.requirement_no || p.b?.id || p.b?.requirement_no) ?? null;
    if (!p.a || !p.b) {
      diffs.push({
        field_path: `requirements[${no ?? "?"}]`, requirement_no: no,
        value_a: p.a ? String(p.a.description || "").slice(0, 160) : "（未提取到）",
        value_b: p.b ? String(p.b.description || "").slice(0, 160) : "（未提取到）",
        severity: "warning", match_method: p.method, match_confidence: p.confidence,
      });
      continue;
    }
    if (norm(p.a.description) !== norm(p.b.description)) {
      const sim = similarity(p.a.description, p.b.description);
      diffs.push({
        field_path: `requirements[${no}].description`, requirement_no: no,
        value_a: String(p.a.description || "").slice(0, 160),
        value_b: String(p.b.description || "").slice(0, 160),
        severity: sim >= 0.8 ? "info" : "warning",
        match_method: p.method, match_confidence: p.confidence,
      });
    }
    // 量化指标不一致 = 高危：直接影响测试判定与得分
    if (norm(p.a.target) !== norm(p.b.target) || norm(p.a.unit) !== norm(p.b.unit) || norm(p.a.tolerance) !== norm(p.b.tolerance)) {
      diffs.push({
        field_path: `requirements[${no}].target`, requirement_no: no,
        value_a: `${p.a.target ?? "—"}${p.a.unit ?? ""} ${p.a.tolerance ?? ""}`.trim(),
        value_b: `${p.b.target ?? "—"}${p.b.unit ?? ""} ${p.b.tolerance ?? ""}`.trim(),
        severity: "critical", match_method: p.method, match_confidence: p.confidence,
      });
    }
    if (norm(p.a.priority) !== norm(p.b.priority)) {
      diffs.push({
        field_path: `requirements[${no}].priority`, requirement_no: no,
        value_a: String(p.a.priority ?? ""), value_b: String(p.b.priority ?? ""),
        severity: "warning", match_method: p.method, match_confidence: p.confidence,
      });
    }
  }

  const sa = a.scoring_items || [], sb = b.scoring_items || [];
  const usedB = new Set<number>();
  for (const x of sa) {
    const best = sb.map((y, i) => ({ y, i, s: similarity(x.item, y.item) }))
      .filter(({ i }) => !usedB.has(i)).sort((m, n) => n.s - m.s)[0];
    if (!best || best.s < 0.5) {
      diffs.push({ field_path: `scoring_items[${x.item}]`, value_a: `${x.item}: ${x.points ?? "—"}`,
        value_b: "（未提取到）", severity: "warning", match_method: "unmatched", match_confidence: 0 });
      continue;
    }
    usedB.add(best.i);
    if (Number(x.points ?? -1) !== Number(best.y.points ?? -1)) {
      diffs.push({
        field_path: `scoring_items[${x.item}].points`,
        value_a: `${x.item}: ${x.points ?? "—"}`, value_b: `${best.y.item}: ${best.y.points ?? "—"}`,
        severity: "critical", match_method: "source_quote", match_confidence: best.s,
      });
    }
  }
  sb.forEach((y, i) => {
    if (!usedB.has(i)) diffs.push({ field_path: `scoring_items[${y.item}]`, value_a: "（未提取到）",
      value_b: `${y.item}: ${y.points ?? "—"}`, severity: "warning", match_method: "unmatched", match_confidence: 0 });
  });

  return diffs;
}

export async function saveDiffs(versionId: string, problemId: string, diffs: Diff[], providerA: string, providerB: string) {
  await db().execute({ sql: "DELETE FROM problem_review_diffs WHERE version_id=? AND resolved=0", args: [versionId] }).catch(() => {});
  for (const d of diffs) {
    await db().execute({
      sql: `INSERT INTO problem_review_diffs (problem_id, version_id, requirement_no, field_path,
              provider_a, provider_b, value_a, value_b, severity, match_method, match_confidence)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [problemId, versionId, d.requirement_no ?? null, d.field_path, providerA, providerB,
        d.value_a?.slice(0, 500), d.value_b?.slice(0, 500), d.severity, d.match_method, d.match_confidence],
    }).catch(() => {});
  }
}

/* ============ 发布清单与不可变版本 ============ */

export interface ChecklistItem { key: string; label: string; passed: boolean; detail: string }

/** 发布前检查。全部通过（或 admin 显式 override）才允许发布。 */
export async function publicationChecklist(versionId: string): Promise<{ items: ChecklistItem[]; passed: boolean }> {
  await ensureSchema();
  const content = await getVersionContent(versionId);
  const items: ChecklistItem[] = [];
  if (!content) return { items: [{ key: "exists", label: "版本存在", passed: false, detail: "版本不存在" }], passed: false };

  const reqs = content.requirements;
  const scoring = content.scoring_items;

  items.push({ key: "has_requirements", label: "已提取需求", passed: reqs.length > 0, detail: `${reqs.length} 条` });

  const pending = reqs.filter((r) => !["CONFIRMED", "REJECTED"].includes(String(r.status)));
  items.push({
    key: "all_confirmed", label: "需求全部确认或驳回",
    passed: pending.length === 0,
    detail: pending.length ? `${pending.length} 条待确认：${pending.slice(0, 3).map((r) => r.requirement_no).join("、")}` : "全部已处理",
  });

  const noSource = reqs.filter((r) => String(r.status) !== "REJECTED" && !r.source_quote && r.source_page == null);
  items.push({
    key: "has_source", label: "每条需求有页码或原文引用",
    passed: noSource.length === 0,
    detail: noSource.length ? `${noSource.length} 条缺溯源：${noSource.slice(0, 3).map((r) => r.requirement_no).join("、")}` : "全部有溯源",
  });

  const diffs = await db().execute({
    sql: "SELECT COUNT(*) n FROM problem_review_diffs WHERE version_id=? AND resolved=0 AND severity='critical'",
    args: [versionId],
  }).catch(() => ({ rows: [{ n: 0 }] as any[] }));
  const crit = Number((diffs.rows[0] as any)?.n || 0);
  items.push({ key: "no_critical_diff", label: "无未确认的关键差异", passed: crit === 0, detail: crit ? `${crit} 处指标/分值差异待确认` : "无" });

  const amb = content.notes.filter((n) => String(n.kind) === "ambiguity" && Number(n.resolved) === 0);
  items.push({ key: "ambiguity_resolved", label: "题面歧义已处理", passed: amb.length === 0, detail: amb.length ? `${amb.length} 条未处理` : "无" });

  const official = scoring.filter((s) => String(s.points_type) === "official" && s.points != null);
  const total = official.reduce((a, s) => a + Number(s.points), 0);
  const sane = official.length === 0 || (total > 0 && total <= 200);
  items.push({
    key: "scoring_total", label: "官方评分总分合理",
    passed: sane, detail: official.length ? `官方分值 ${official.length} 项，合计 ${total}` : "题面未给官方分值（按估算口径）",
  });

  const unbound = official.filter((s) => !(s.requirement_ids || []).length);
  items.push({
    key: "scoring_bound", label: "官方评分项已绑定需求",
    passed: unbound.length === 0,
    detail: unbound.length ? `${unbound.length} 项未绑定` : official.length ? "全部已绑定" : "无官方分值项",
  });

  const reviewers = new Set(content.reviews.filter((r) => String(r.decision) === "approve").map((r) => String(r.reviewer)));
  items.push({
    key: "two_reviewers", label: "至少两名工作人员审核通过",
    passed: reviewers.size >= 2, detail: `${reviewers.size} 人已通过`,
  });

  return { items, passed: items.every((i) => i.passed) };
}

export async function addReview(versionId: string, reviewer: string, decision: "approve" | "reject", note?: string) {
  await ensureSchema();
  await db().execute({
    sql: "INSERT INTO problem_reviews (review_id, version_id, reviewer, decision, note) VALUES (?,?,?,?,?)",
    args: [uid("PRV"), versionId, reviewer, decision, note || null],
  });
}

/** 发布版本：通过清单后冻结为不可变版本。 */
export async function publishVersion(versionId: string, publishedBy: string, override = false):
  Promise<{ ok: boolean; error?: string; checklist?: ChecklistItem[] }> {
  await ensureSchema();
  const { items, passed } = await publicationChecklist(versionId);
  if (!passed && !override) {
    const failed = items.filter((i) => !i.passed).map((i) => i.label).join("、");
    return { ok: false, error: `发布清单未通过：${failed}`, checklist: items };
  }

  const content = await getVersionContent(versionId);
  if (!content) return { ok: false, error: "版本不存在" };
  const hash = createHash("sha256")
    .update(JSON.stringify({ r: content.requirements, s: content.scoring_items }))
    .digest("hex").slice(0, 32);

  await db().execute({
    sql: `UPDATE problem_versions SET status='published', published_by=?, published_at=now(),
            immutable=1, content_hash=? WHERE version_id=? AND status != 'published'`,
    args: [publishedBy + (override ? " (override)" : ""), hash, versionId],
  });
  await db().execute({
    sql: `UPDATE official_problems SET status='published', updated_at=now()
          WHERE problem_id=(SELECT problem_id FROM problem_versions WHERE version_id=?)`,
    args: [versionId],
  });
  return { ok: true, checklist: items };
}

/** 迁移 21 之前 official_problems 没有分类列。
 *  新代码直接 SELECT 会让整个列表查询失败、页面显示「还没有题目」，
 *  掩盖真实原因。这里对缺列做降级，并在返回值里标明。 */
const PG_UNDEFINED_COLUMN = "42703";
const TAXONOMY_COLS = "p.contest_type, p.region, p.tech_tags, p.source_url, p.difficulty";
const TAXONOMY_FALLBACK = "'national' AS contest_type, NULL AS region, NULL AS tech_tags, NULL AS source_url, NULL AS difficulty";

export async function listProblems(opts: {
  publishedOnly?: boolean;
  year?: number;
  contestType?: string;
  region?: string;
  tech?: string;
  keyword?: string;
} = {}) {
  await ensureSchema();
  const where: string[] = [];
  const args: any[] = [];
  if (opts.year) { where.push("p.year=?"); args.push(opts.year); }
  if (opts.keyword) { where.push("(p.title ILIKE ? OR p.code ILIKE ?)"); args.push(`%${opts.keyword}%`, `%${opts.keyword}%`); }

  // 分类相关的过滤条件只在有列时才加
  const taxonomyWhere: string[] = [];
  const taxonomyArgs: any[] = [];
  if (opts.contestType) { taxonomyWhere.push("p.contest_type=?"); taxonomyArgs.push(opts.contestType); }
  if (opts.region) { taxonomyWhere.push("p.region=?"); taxonomyArgs.push(opts.region); }
  if (opts.tech) { taxonomyWhere.push("p.tech_tags LIKE ?"); taxonomyArgs.push(`%"${opts.tech}"%`); }

  const build = (cols: string, extraWhere: string[], extraArgs: any[]) => {
    const all = [...where, ...extraWhere];
    return {
      sql: `SELECT p.problem_id, p.year, p.code, p.title, p.group_name, p.status, ${cols},
              (SELECT version_no FROM problem_versions v WHERE v.problem_id=p.problem_id AND v.status='published' ORDER BY version_no DESC LIMIT 1) published_version,
              (SELECT version_id FROM problem_versions v WHERE v.problem_id=p.problem_id AND v.status='published' ORDER BY version_no DESC LIMIT 1) published_version_id,
              (SELECT COUNT(*) FROM problem_requirements r
                 JOIN problem_versions v2 ON v2.version_id = r.version_id
                 WHERE v2.problem_id = p.problem_id AND v2.status='published') requirement_count,
              (SELECT COUNT(*) FROM problem_review_diffs d
                 JOIN problem_versions v3 ON v3.version_id = d.version_id
                 WHERE v3.problem_id = p.problem_id AND d.resolved = 0 AND d.severity='critical') open_critical
            FROM official_problems p
            ${all.length ? "WHERE " + all.join(" AND ") : ""}
            ORDER BY p.year DESC, p.code ASC LIMIT 500`,
      args: [...args, ...extraArgs],
    };
  };

  let rs: { rows: any[] };
  let taxonomyReady = true;
  try {
    const q = build(TAXONOMY_COLS, taxonomyWhere, taxonomyArgs);
    rs = await db().execute(q);
  } catch (e: any) {
    if (e?.code !== PG_UNDEFINED_COLUMN) throw e;
    // 数据库结构落后于代码：降级为不含分类列的查询，让列表仍能显示
    taxonomyReady = false;
    rs = await db().execute(build(TAXONOMY_FALLBACK, [], []));
  }

  const rows = (rs.rows as any[]).map((r) => ({
    ...r,
    tech_tags: parseTags(r.tech_tags),
    taxonomy_ready: taxonomyReady,
  }));
  return opts.publishedOnly ? rows.filter((r) => r.published_version_id) : rows;
}

/** 检索维度的可选值与计数，供前端筛选器渲染 */
export async function problemFacets(publishedOnly = true) {
  await ensureSchema();
  // 缺列时返回空分面，前端据此隐藏筛选器
  try {
    return await problemFacetsInner(publishedOnly);
  } catch (e: any) {
    if (e?.code !== PG_UNDEFINED_COLUMN) throw e;
    return { years: [], contestTypes: [], regions: [], tech: [], taxonomy_ready: false };
  }
}

async function problemFacetsInner(publishedOnly = true) {
  // 用 1=1 打底，后续条件一律用 AND 拼接，避免 WHERE/AND 的字符串拼接错误
  const cond = publishedOnly
    ? `WHERE EXISTS (SELECT 1 FROM problem_versions v WHERE v.problem_id=p.problem_id AND v.status='published')`
    : "WHERE 1=1";
  const [years, contests, regions] = await Promise.all([
    db().execute({ sql: `SELECT year, COUNT(*) n FROM official_problems p ${cond} GROUP BY year ORDER BY year DESC`, args: [] }),
    db().execute({ sql: `SELECT contest_type, COUNT(*) n FROM official_problems p ${cond} GROUP BY contest_type`, args: [] }),
    db().execute({
      sql: `SELECT region, COUNT(*) n FROM official_problems p ${cond} AND region IS NOT NULL
            GROUP BY region ORDER BY n DESC`,
      args: [],
    }),
  ]);
  // 技术方向需要展开 JSON 数组，在应用层统计
  const all = await db().execute({ sql: `SELECT tech_tags FROM official_problems p ${cond}`, args: [] });
  const techCount: Record<string, number> = {};
  for (const r of all.rows as any[]) {
    for (const t of parseTags(r.tech_tags)) techCount[t] = (techCount[t] || 0) + 1;
  }
  return {
    years: (years.rows as any[]).map((r) => ({ value: Number(r.year), count: Number(r.n) })),
    contestTypes: (contests.rows as any[]).map((r) => ({ value: String(r.contest_type), count: Number(r.n) })),
    regions: (regions.rows as any[]).map((r) => ({ value: String(r.region), count: Number(r.n) })),
    tech: Object.entries(techCount).map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count),
  };
}


/** 删除题目及其全部版本内容。
 *  已发布版本可能被用户项目引用，因此默认拒绝删除 —— 
 *  引用方会突然找不到需求来源。确需删除时用 force。 */
export async function deleteProblem(problemId: string, opts: { force?: boolean } = {}): Promise<{
  ok: boolean; error?: string; deleted?: { versions: number; requirements: number };
}> {
  await ensureSchema();

  const pub = await db().execute({
    sql: "SELECT COUNT(*) n FROM problem_versions WHERE problem_id=? AND status='published'",
    args: [problemId],
  });
  const publishedCount = Number((pub.rows[0] as any)?.n || 0);
  if (publishedCount > 0 && !opts.force) {
    return {
      ok: false,
      error: `该题有 ${publishedCount} 个已发布版本，用户项目可能正在引用。` +
             `确认要删除请使用强制删除。`,
    };
  }

  // 引用检查：已被项目采用的题目删除后，那些项目会失去需求来源
  const used = await db().execute({
    sql: "SELECT COUNT(*) n FROM projects WHERE problem_id=?",
    args: [problemId],
  }).catch(() => ({ rows: [{ n: 0 }] as any[] }));
  const usedCount = Number((used.rows[0] as any)?.n || 0);
  if (usedCount > 0 && !opts.force) {
    return { ok: false, error: `已有 ${usedCount} 个项目采用该题目，删除会使其失去需求来源。` };
  }

  return withTransaction(async (tx) => {
    const vs = await tx.execute({
      sql: "SELECT version_id FROM problem_versions WHERE problem_id=?", args: [problemId],
    });
    const versionIds = (vs.rows as any[]).map((r) => String(r.version_id));

    let reqCount = 0;
    for (const vid of versionIds) {
      // 各表主键列名不同，RETURNING 必须用实际存在的列
      const rq = await tx.execute({ sql: "DELETE FROM problem_requirements WHERE version_id=? RETURNING req_id", args: [vid] });
      reqCount += rq.rows.length;
      await tx.execute({ sql: "DELETE FROM problem_scoring_items WHERE version_id=?", args: [vid] });
      await tx.execute({ sql: "DELETE FROM problem_notes WHERE version_id=?", args: [vid] });
      await tx.execute({ sql: "DELETE FROM problem_reviews WHERE version_id=?", args: [vid] });
    }
    // 差异表按 problem_id 关联，不是 version_id
    await tx.execute({ sql: "DELETE FROM problem_review_diffs WHERE problem_id=?", args: [problemId] });
    await tx.execute({ sql: "DELETE FROM problem_versions WHERE problem_id=?", args: [problemId] });
    await tx.execute({ sql: "DELETE FROM official_problems WHERE problem_id=?", args: [problemId] });

    return { ok: true, deleted: { versions: versionIds.length, requirements: reqCount } };
  });
}

/** 读取某版本的题面歧义（含候选解释与决策） */
export async function getAmbiguities(versionId: string): Promise<Ambiguity[]> {
  await ensureSchema();
  const rs = await db().execute({
    sql: `SELECT note_id, content, resolved, resolution, options, decision,
            COALESCE(severity, 'normal') AS severity, decided_by, decided_at
          FROM problem_notes WHERE version_id=? AND kind='ambiguity'
          ORDER BY severity, created_at`,
    args: [versionId],
  });
  return (rs.rows as any[]).map((r) => ({
    note_id: String(r.note_id),
    content: String(r.content),
    severity: String(r.severity) === "critical" ? "critical" : "normal",
    options: parseOptions(r.options),
    resolved: Number(r.resolved) === 1,
    decision: parseDecision(r.decision) ?? (r.resolution ? { kind: "custom", note: String(r.resolution) } : null),
    decided_by: r.decided_by ? String(r.decided_by) : null,
    decided_at: r.decided_at ? String(r.decided_at) : null,
  }));
}

/** 记录一项歧义决策。校验不通过时返回错误说明。 */
export async function decideAmbiguity(noteId: string, decision: any, decidedBy: string): Promise<{
  ok: boolean; error?: string;
}> {
  await ensureSchema();
  const { parseDecision: pd, validateDecision } = await import("./ambiguity");
  const d = pd(decision);
  if (!d) return { ok: false, error: "决策内容无法识别" };

  const cur = await db().execute({
    sql: "SELECT options FROM problem_notes WHERE note_id=?", args: [noteId],
  });
  if (!cur.rows.length) return { ok: false, error: "歧义记录不存在" };

  const err = validateDecision(d, parseOptions((cur.rows[0] as any).options));
  if (err) return { ok: false, error: err };

  await db().execute({
    sql: `UPDATE problem_notes SET resolved=1, decision=?, decided_by=?, decided_at=now(),
            resolution=? WHERE note_id=?`,
    args: [JSON.stringify(d), decidedBy,
      d.kind === "adopt_option" ? `采用解释 ${d.optionKey}` : (d.note || d.kind), noteId],
  });
  return { ok: true };
}
