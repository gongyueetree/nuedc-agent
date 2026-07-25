import type { NextRequest } from "next/server";
import type { UserTier, ModuleCertState } from "./types";
import { MODULE_CERT_STATES, PAID_DOWNLOAD_MIN_STATE } from "./types";
import { ADMIN_COOKIE, verifyAdminToken, safeEqual } from "./admin-session";
import { db, ensureSchema } from "./db";

export function safeEqualStr(a: string, b: string): boolean { return safeEqual(a, b); }

// ============================================================
// 鉴权策略：
//  - 独立部署：X-Api-Key 匹配 ADMIN_API_KEY → admin
//  - 嵌入 ezPLM：ezPLM 服务端用 EZPLM_API_KEY 调用，并在
//    X-User-Tier 头里声明用户等级（ezPLM 已经管理付费状态，
//    本应用信任其声明，不重复做一套账号体系）
//  - 其他请求 → free
// ============================================================

export function resolveTier(req: NextRequest): UserTier {
  // 管理后台会话 cookie（短期 HMAC 令牌，浏览器不持有长期密钥）
  if (verifyAdminToken(req.cookies.get(ADMIN_COOKIE)?.value, process.env.ADMIN_API_KEY)) return "admin";
  const key = req.headers.get("x-api-key") || "";
  if (process.env.ADMIN_API_KEY && key === process.env.ADMIN_API_KEY) return "admin";
  if (process.env.EZPLM_API_KEY && key === process.env.EZPLM_API_KEY) {
    const declared = (req.headers.get("x-user-tier") || "free") as UserTier;
    return (["free", "paid", "lab", "admin"] as UserTier[]).includes(declared) ? declared : "free";
  }
  return "free";
}

export function canDownloadAssets(tier: UserTier, cert: ModuleCertState): boolean {
  if (tier === "admin" || tier === "lab") return true;
  if (tier === "paid") {
    return MODULE_CERT_STATES.indexOf(cert) >= MODULE_CERT_STATES.indexOf(PAID_DOWNLOAD_MIN_STATE);
  }
  return false; // 免费用户只能浏览基础资料
}

export function canReviewModules(tier: UserTier): boolean {
  return tier === "admin" || tier === "lab";
}

export function canUploadModules(tier: UserTier): boolean {
  return tier !== "free";
}

/** 免费用户可见的模块字段（隐藏原理图/PCB/代码仓库等完整资产） */
export function stripPaidFields(moduleData: any) {
  const { schematic_assets, pcb_assets, code_repositories, ...rest } = moduleData;
  return {
    ...rest,
    schematic_assets: [],
    pcb_assets: [],
    code_repositories: [],
    assets_locked: true,
  };
}


// ============ 项目归属（诊断 5.5 轻量版）============
// ezPLM 服务端调用：X-User-Id 头（与 EZPLM_API_KEY 同时出现才可信）
// 浏览器直连：匿名 uid cookie（首次访问签发）——账号级隔离待 ezPLM SSO
import { NextResponse } from "next/server";

export function resolveOwner(req: NextRequest): { owner: string; isNew: boolean } {
  const key = req.headers.get("x-api-key") || "";
  // 服务端代理调用：ezPLM 用共享密钥 + 用户头声明身份
  if (process.env.EZPLM_API_KEY && key === process.env.EZPLM_API_KEY) {
    const u = req.headers.get("x-user-id");
    if (u) return { owner: `ezplm:${u}`, isNew: false };
  }
  // 嵌入会话 cookie（iframe 场景）：优先级高于匿名 cookie
  {
    const { verifySessionCookieToken, SESSION_COOKIE } = require("./ezplm-session");
    const s = verifySessionCookieToken(req.cookies.get(SESSION_COOKIE)?.value);
    if (s) return { owner: `ezplm:${s.sub}`, isNew: false };
  }
  const cookie = req.cookies.get("nuedc_uid")?.value;
  if (cookie) return { owner: cookie, isNew: false };
  return { owner: `anon:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`, isNew: true };
}

export function withOwnerCookie<T extends NextResponse>(res: T, owner: string, isNew: boolean): T {
  if (isNew && owner.startsWith("anon:")) {
    res.cookies.set("nuedc_uid", owner, { httpOnly: true, sameSite: "lax", maxAge: 400 * 24 * 3600, path: "/" });
  }
  return res;
}


/** 纯判定函数（单测覆盖权限矩阵用） */
export function canAccessProject(tier: UserTier, projectOwner: string | null, requester: string, isMember: boolean): boolean {
  if (tier === "admin") return true;
  if (projectOwner !== null && projectOwner === requester) return true;
  return isMember;
}

/** 项目访问校验：所有者 / 成员 / admin。返回 null = 放行。 */
export async function assertProjectAccess(req: NextRequest, projectId: string): Promise<NextResponse | null> {
  await ensureSchema();
  const tier = resolveTier(req);
  if (tier === "admin") return null;
  const rs = await db().execute({ sql: "SELECT owner FROM projects WHERE project_id=?", args: [projectId] });
  if (!rs.rows.length) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  const { owner } = resolveOwner(req);
  const mem = await db().execute({
    sql: "SELECT 1 AS x FROM project_members WHERE project_id=? AND user_ref=?", args: [projectId, owner] });
  if (!canAccessProject(tier, String(rs.rows[0].owner), owner, mem.rows.length > 0)) {
    return NextResponse.json({ error: "无权访问该项目" }, { status: 403 });
  }
  return null;
}


/** 组织身份。X-Org-Id / X-Org-Role 只在 X-Api-Key 匹配 EZPLM_API_KEY 时可信；
 *  否则一律从签名过的会话 cookie 读取 —— 请求头可伪造，cookie 不能。 */
export function resolveOrg(req: NextRequest): { orgRef: string | null; orgRole: "org_admin" | "member" | null } {
  const key = req.headers.get("x-api-key") || "";
  if (process.env.EZPLM_API_KEY && key === process.env.EZPLM_API_KEY) {
    const org = req.headers.get("x-org-id");
    if (org) {
      const role = req.headers.get("x-org-role") === "org_admin" ? "org_admin" : "member";
      return { orgRef: `ezplm:${org}`, orgRole: role };
    }
  }
  const { verifySessionCookieToken, SESSION_COOKIE } = require("./ezplm-session");
  const s = verifySessionCookieToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (s) return { orgRef: `ezplm:${s.org}`, orgRole: s.orgRole };

  // 组织管理后台会话
  const { readAdminSession, ORG_ADMIN_COOKIE } = require("./admin-session");
  const a = readAdminSession(req.cookies.get(ORG_ADMIN_COOKIE)?.value, process.env.ADMIN_API_KEY);
  if (a?.role === "org_admin" && a.org) return { orgRef: a.org, orgRole: "org_admin" };

  return { orgRef: null, orgRole: null };
}
