import type { Identity } from "./identity";
import type { ModuleScope } from "./module-search";
import type { ModuleCertState } from "./types";

/** 模块访问控制。纯函数，便于单测覆盖每条权限规则。
 *
 *  核心原则：
 *  - 平台库（PUBLIC）与最高认证（COMPETITION_READY）只有平台 lab/admin 能碰
 *  - 组织管理员只能管本组织的 ORGANIZATION 模块，认证封顶 FUNCTION_TESTED
 *  - 个人模块只有本人能改
 *  - scope/owner_ref/org_ref 永远由服务端按身份决定，不采信请求体 */

export interface ModuleRow {
  id?: string;
  scope?: string | null;
  owner_ref?: string | null;
  org_ref?: string | null;
  certification_status?: string | null;
}

const isPlatformStaff = (id: Identity) => id.tier === "admin" || id.tier === "lab";

/** 组织内认证晋级上限：组织自建模块不能自称"赛用认证" */
export const ORG_MAX_CERT: ModuleCertState = "FUNCTION_TESTED";

const CERT_ORDER: ModuleCertState[] = [
  "DRAFT", "DOCUMENTED", "POWER_TESTED", "FUNCTION_TESTED", "BENCHMARKED", "COMPETITION_READY",
];

export function canCreateModule(id: Identity): boolean {
  // 平台人员、组织成员、以及有付费权益的个人都可以创建
  return isPlatformStaff(id) || !!id.org || id.tier === "paid";
}

/** 新建模块的默认可见范围：有组织归组织，否则归个人；PUBLIC 只有平台能建 */
export function defaultScopeFor(id: Identity): ModuleScope {
  if (isPlatformStaff(id)) return "PUBLIC";
  if (id.org) return "ORGANIZATION";
  return "PERSONAL";
}

/** 请求方是否允许把模块建成指定 scope */
export function canUseScope(id: Identity, scope: ModuleScope): boolean {
  if (scope === "PUBLIC") return isPlatformStaff(id);
  if (scope === "ORGANIZATION") return isPlatformStaff(id) || !!id.org;
  return true;   // PERSONAL / TEAM 任何登录者都可以
}

export function canEditModule(id: Identity, m: ModuleRow): boolean {
  if (isPlatformStaff(id)) return true;
  const scope = String(m.scope || "PUBLIC");
  // 组织管理员：仅限本组织的组织级模块
  if (id.orgRole === "org_admin" && scope === "ORGANIZATION" && m.org_ref && m.org_ref === id.org) return true;
  // 个人模块：仅本人
  if ((scope === "PERSONAL" || scope === "TEAM") && m.owner_ref && m.owner_ref === id.owner) return true;
  return false;
}

/** 审核（变更认证状态）权限，比编辑更严格 */
export function canReviewModule(id: Identity, m: ModuleRow): boolean {
  if (isPlatformStaff(id)) return true;
  const scope = String(m.scope || "PUBLIC");
  return id.orgRole === "org_admin" && scope === "ORGANIZATION" && !!m.org_ref && m.org_ref === id.org;
}

/** 该身份最高能把这个模块晋级到什么认证状态 */
export function maxPromotableState(id: Identity, m: ModuleRow): ModuleCertState {
  if (isPlatformStaff(id)) return "COMPETITION_READY";
  return ORG_MAX_CERT;
}

export function canPromoteTo(id: Identity, m: ModuleRow, target: ModuleCertState): boolean {
  if (!canReviewModule(id, m)) return false;
  const max = maxPromotableState(id, m);
  return CERT_ORDER.indexOf(target) <= CERT_ORDER.indexOf(max);
}

/** 服务端权威的归属字段：无论客户端传什么，一律以身份为准 */
export function resolveOwnership(id: Identity, requestedScope?: string | null): {
  scope: ModuleScope; owner_ref: string; org_ref: string | null;
} {
  let scope = (requestedScope as ModuleScope) || defaultScopeFor(id);
  if (!canUseScope(id, scope)) scope = defaultScopeFor(id);
  return {
    scope,
    owner_ref: id.owner,
    org_ref: scope === "ORGANIZATION" ? id.org : null,
  };
}
