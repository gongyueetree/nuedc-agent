import type { ContextManifest } from "./model-gateway/context-builder";
import { estimateTokens } from "./model-gateway/context-builder";

/** 模块 Top-K 检索。取代「按认证等级排序取前 40」的粗糙做法：
 *  先按 scope/类别/电压/接口/库存做程序过滤，再按证据与认证排序，最后截断到 topK。
 *  每个入选模块附带 selectionReason，运营与用户都能看懂为什么选它。 */

export const MODULE_SCOPES = ["PERSONAL", "TEAM", "ORGANIZATION", "PUBLIC"] as const;
export type ModuleScope = (typeof MODULE_SCOPES)[number];

/** 归属加权（契约固定值）：功能等价时本组织模块必须排在公共模块之前 */
export const SCOPE_BONUS: Record<string, number> = {
  PERSONAL: 120, TEAM: 110, ORGANIZATION: 100, PUBLIC: 0,
};

/** 公共模块保底数量：组织库只有两三个模块时不能把候选集饿死，
 *  否则方案生成会因为可选器件太少而质量下降 */
export const PUBLIC_FLOOR = 5;

const CERT_RANK: Record<string, number> = {
  COMPETITION_READY: 0, BENCHMARKED: 1, FUNCTION_TESTED: 2,
  POWER_TESTED: 3, DOCUMENTED: 4, DRAFT: 5, DEPRECATED: 9,
};
const EVIDENCE_RANK: Record<string, number> = { E6: 0, E5: 1, E4: 2, E3: 3, E2: 4, E1: 5, E0: 6 };

export interface SearchOptions {
  /** 可见范围：用户自己的 + 团队 + 组织 + 公共 */
  viewerRef?: string | null;
  orgRef?: string | null;
  categories?: string[];
  requirementTags?: string[];
  voltage?: number;
  interfaces?: string[];
  minPeakCurrentMa?: number;
  preferInventory?: boolean;
  preferred?: string[];
  topK?: number;
}

export interface ScoredModule {
  module: any;
  score: number;
  reasons: string[];
}

/** 从需求里抽取可用于匹配的关键词 */
export function extractTags(requirements: any[]): string[] {
  const words = (requirements || [])
    .flatMap((r) => String(r.description || "").match(/[\u4e00-\u9fff]{2,6}|[A-Za-z][A-Za-z0-9]{2,}/g) || [])
    .map((w) => w.toLowerCase());
  // 去重并保留高频词（出现越多说明越贴题）
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([w]) => w);
}

/** 可见性过滤：只返回调用者有权看到的模块 */
export function visibleTo(m: any, opts: SearchOptions): boolean {
  const scope = String(m.scope || "PUBLIC") as ModuleScope;
  if (scope === "PUBLIC") return true;
  if (scope === "ORGANIZATION") return !!opts.orgRef && String(m.org_ref) === opts.orgRef;
  if (scope === "TEAM" || scope === "PERSONAL") {
    return !!opts.viewerRef && String(m.owner_ref) === opts.viewerRef;
  }
  return false;
}

export function searchModules(all: any[], opts: SearchOptions = {}): { picked: ScoredModule[]; filteredOut: number } {
  const topK = opts.topK ?? 20;
  const preferred = new Set(opts.preferred || []);
  const tags = (opts.requirementTags || []).map((t) => t.toLowerCase());

  // ---- 1. 硬过滤（程序判定，不消耗模型）----
  const candidates = all.filter((m) => {
    if (!visibleTo(m, opts)) return false;
    if (String(m.certification_status) === "DEPRECATED") return false;
    if (opts.categories?.length && !opts.categories.some((c) => String(m.category || "").startsWith(c))) return false;
    if (opts.interfaces?.length) {
      const has = (m.interfaces || []).some((i: any) => opts.interfaces!.includes(String(i.interface_type)));
      if (!has) return false;
    }
    if (opts.voltage != null && m.power?.input_voltage_range?.length === 2) {
      const [lo, hi] = m.power.input_voltage_range;
      if (opts.voltage < lo || opts.voltage > hi) return false;
    }
    if (opts.minPeakCurrentMa != null) {
      const peak = m.power?.peak_current_ma;
      if (peak != null && peak < opts.minPeakCurrentMa) return false;
    }
    return true;
  });

  // ---- 2. 打分排序（可解释）----
  const scored: ScoredModule[] = candidates.map((m) => {
    const reasons: string[] = [];
    let score = 0;

    if (preferred.has(m.id)) { score += 100; reasons.push("用户已选用"); }

    const scope = String(m.scope || "PUBLIC");
    const bonus = SCOPE_BONUS[scope] ?? 0;
    if (bonus > 0) {
      score += bonus;
      // 理由文案固定，前端与 LLM prompt 都依赖它
      reasons.push(scope === "ORGANIZATION" ? "本组织模块" : "我的模块");
    }

    const cert = CERT_RANK[String(m.certification_status)] ?? 6;
    const certPts = (7 - cert) * 4;
    score += certPts;
    if (cert <= 2) reasons.push(`认证 ${m.certification_status}`);

    // 证据等级：有实验室实测数据的优先
    const best = (m.evidence_records || [])
      .map((e: any) => EVIDENCE_RANK[String(e.evidence_level)] ?? 6)
      .sort((a: number, b: number) => a - b)[0];
    if (best != null) {
      score += (7 - best) * 3;
      if (best <= 1) reasons.push("有实验室实测数据");
    }

    // 需求关键词命中
    const hay = `${m.name} ${m.main_chip ?? ""} ${(m.tags || []).join(" ")} ${m.category ?? ""} ${m.description ?? ""}`.toLowerCase();
    const hits = tags.filter((t) => t.length > 1 && hay.includes(t));
    if (hits.length) { score += Math.min(30, hits.length * 4); reasons.push(`匹配需求关键词：${hits.slice(0, 3).join("/")}`); }

    // 有库存优先（比赛现场最实际的约束）
    const qty = Number(m.inventory_qty || 0);
    if (opts.preferInventory !== false && qty > 0) { score += 12; reasons.push(`实验室有货 ×${qty}`); }

    if (opts.voltage != null && m.power?.input_voltage_range?.length === 2) reasons.push(`供电兼容 ${opts.voltage}V`);
    if (opts.interfaces?.length) reasons.push(`接口匹配 ${opts.interfaces.join("/")}`);

    if (!reasons.length) reasons.push("候选补充");
    return { module: m, score, reasons };
  });

  scored.sort((a, b) => b.score - a.score);

  // 先按分数取 topK，再检查公共模块是否够数；不够就用高分公共模块替换末位私有模块
  const picked = scored.slice(0, topK);
  const isPublic = (x: ScoredModule) => String(x.module.scope || "PUBLIC") === "PUBLIC";
  const publicPool = scored.filter(isPublic);
  const floor = Math.min(PUBLIC_FLOOR, publicPool.length);
  let publicInPicked = picked.filter(isPublic).length;

  if (publicInPicked < floor) {
    const pickedIds = new Set(picked.map((p) => p.module.id));
    for (const cand of publicPool) {
      if (publicInPicked >= floor) break;
      if (pickedIds.has(cand.module.id)) continue;
      // 从末位开始替换非公共模块
      for (let i = picked.length - 1; i >= 0; i--) {
        if (!isPublic(picked[i])) {
          pickedIds.delete(picked[i].module.id);
          picked[i] = cand;
          pickedIds.add(cand.module.id);
          publicInPicked++;
          break;
        }
      }
    }
    picked.sort((a, b) => b.score - a.score);
  }

  return { picked, filteredOut: all.length - picked.length };
}

/** 生成送入模型的目录文本 + contextManifest */
export function buildModuleContext(all: any[], opts: SearchOptions = {}): {
  text: string; manifest: Pick<ContextManifest, "includedModuleIds" | "omittedModuleCount" | "estimatedTokens"> & {
    selectionReasons: Record<string, string[]>;
  };
} {
  const { picked } = searchModules(all, opts);
  const lines = picked.map(({ module: m, reasons }) => {
    const own = String(m.scope || "PUBLIC") === "ORGANIZATION" ? " | 【本组织】"
      : ["PERSONAL", "TEAM"].includes(String(m.scope)) ? " | 【我的】" : "";
    const ifaces = (m.interfaces || [])
      .map((i: any) => `${i.name}:${i.interface_type}@${i.voltage_level ?? "?"}V`).join(",");
    const power = m.power
      ? `供电${(m.power.input_voltage_range || []).join("-")}V/典型${m.power.typical_current_ma ?? "?"}mA/峰值${m.power.peak_current_ma ?? "?"}mA`
      : "";
    return `- id=${m.id} | ${m.name} | ${m.category} | 芯片:${m.main_chip ?? "?"} | 接口:[${ifaces}] | ${power} | 认证:${m.certification_status}${own}`;
  });
  const omitted = all.length - picked.length;
  const text = lines.join("\n") + (omitted > 0
    ? `\n（另有 ${omitted} 个模块未列出：已按可见范围、类别、电压、接口与库存筛选后取前 ${picked.length}；如需其他器件可将 module_id 留空并在 name 中说明）`
    : "");

  return {
    text,
    manifest: {
      includedModuleIds: picked.map((p) => p.module.id),
      omittedModuleCount: omitted,
      selectionReasons: Object.fromEntries(picked.map((p) => [p.module.id, p.reasons])),
      estimatedTokens: estimateTokens(text),
    },
  };
}
