import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db, ensureSchema } from "./db";
import { resolveTier, resolveOwner, resolveOrg } from "./auth";
import { verifyTeamToken, TEAM_COOKIE } from "./team";
import type { UserTier } from "./types";

/** 统一身份（诊断第五节）：所有 API 只调这一个函数，消除三套 tier 判断。 */
export interface Identity {
  owner: string;
  tier: UserTier;
  /** 队伍标识。同队成员共享项目，不同队伍互不可见。
   *  未加入队伍时为 null，此时只能看到自己设备创建的项目。 */
  team: string | null;
  teamCode: string | null;
  memberName: string | null;
  /** 组织标识，形如 ezplm:ws-b1207e；无组织为 null */
  org: string | null;
  orgRole: "org_admin" | "member" | null;
  source: "admin_key" | "admin_session" | "ezplm" | "ezplm_session" | "entitlement" | "anonymous";
  isNewOwner: boolean;
}

/** 从 cookie 解析队伍身份 */
function teamOf(req: NextRequest): { team: string | null; teamCode: string | null; memberName: string | null } {
  const t = verifyTeamToken(req.cookies.get(TEAM_COOKIE)?.value);
  return { team: t?.teamRef ?? null, teamCode: t?.code ?? null, memberName: t?.member ?? null };
}

export async function getRequestIdentity(req: NextRequest): Promise<Identity> {
  const base = resolveTier(req);          // admin cookie / ADMIN_API_KEY / ezPLM 头
  const { owner, isNew } = resolveOwner(req);
  const { orgRef, orgRole } = resolveOrg(req);

  if (base !== "free") {
    const source = req.headers.get("x-api-key") ? (base === "admin" ? "admin_key" : "ezplm") : "admin_session";
    return { owner, tier: base, org: orgRef, orgRole, ...teamOf(req), source, isNewOwner: isNew };
  }

  // 组织管理员（后台会话）：付费层 + 组织身份，但不是平台 admin
  if (orgRole === "org_admin" && orgRef) {
    const { readAdminSession, ORG_ADMIN_COOKIE } = await import("./admin-session");
    const a = readAdminSession(req.cookies.get(ORG_ADMIN_COOKIE)?.value, process.env.ADMIN_API_KEY);
    if (a?.role === "org_admin") {
      return { owner, tier: "paid", org: orgRef, orgRole, ...teamOf(req), source: "ezplm_session", isNewOwner: isNew };
    }
  }

  // ezPLM 嵌入会话：有组织身份即视为付费层（由 ezPLM 侧授权）
  if (orgRef) {
    const { verifySessionCookieToken, SESSION_COOKIE } = await import("./ezplm-session");
    const s = verifySessionCookieToken(req.cookies.get(SESSION_COOKIE)?.value);
    if (s) {
      return { owner, tier: (s.tier as UserTier) || "paid", org: orgRef, orgRole, ...teamOf(req), source: "ezplm_session", isNewOwner: isNew };
    }
  }
  // 权益表：兑换码/订阅授予的 tier（支持到期与撤销）
  try {
    await ensureSchema();
    const rs = await db().execute({
      sql: `SELECT tier FROM user_entitlements
            WHERE owner=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
            ORDER BY granted_at DESC LIMIT 1`,
      args: [owner],
    });
    if (rs.rows.length) {
      return { owner, tier: String(rs.rows[0].tier) as UserTier, org: orgRef, orgRole, ...teamOf(req), source: "entitlement", isNewOwner: isNew };
    }
  } catch { /* 数据库不可用时降级为 free */ }
  return { owner, tier: "free", org: orgRef, orgRole, ...teamOf(req), source: "anonymous", isNewOwner: isNew };
}

/** 首次访问的匿名身份需要下发 cookie */
export function withIdentityCookie<T extends NextResponse>(res: T, id: Identity): T {
  if (id.isNewOwner && id.owner.startsWith("anon:")) {
    res.cookies.set("nuedc_uid", id.owner, { httpOnly: true, sameSite: "lax", maxAge: 400 * 24 * 3600, path: "/" });
  }
  return res;
}
