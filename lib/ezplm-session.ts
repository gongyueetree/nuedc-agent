import { createHmac, timingSafeEqual } from "node:crypto";

/** ezPLM 嵌入会话。
 *  iframe 场景下浏览器直连本服务，无法传自定义请求头，
 *  因此由 ezPLM 后端签发短期 JWT，本服务验签后换成 httpOnly cookie。 */

export const SESSION_COOKIE = "nuedc_sess";
export const SESSION_TTL_MS = 8 * 3600 * 1000;
const MAX_TOKEN_LIFETIME_SEC = 600;   // 契约：exp - iat ≤ 600

export interface EzplmClaims {
  sub: string;              // ezPLM 用户 id
  org: string;              // workspace id，如 ws-b1207e
  orgRole: "org_admin" | "member";
  tier: string;
  ezplmProjectId?: string | null;
}

function b64urlDecode(s: string): string {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** 验证 ezPLM 签发的 JWT。失败一律返回 null，不抛异常也不区分失败原因。 */
export function verifyEzplmToken(token: string | null | undefined): EzplmClaims | null {
  const secret = process.env.EZPLM_JWT_SECRET;
  if (!secret || !token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;

  let header: any, payload: any;
  try {
    header = JSON.parse(b64urlDecode(h));
    payload = JSON.parse(b64urlDecode(p));
  } catch { return null; }

  // 拒绝 alg=none 与非 HS256（防算法混淆攻击）
  if (header?.alg !== "HS256" || header?.typ && header.typ !== "JWT") return null;

  const expected = b64url(createHmac("sha256", secret).update(`${h}.${p}`).digest());
  if (!safeEq(sig, expected)) return null;

  const now = Math.floor(Date.now() / 1000);
  const { iat, exp, sub, org, org_role, tier, ezplm_project_id } = payload || {};
  if (typeof exp !== "number" || exp <= now) return null;
  if (typeof iat !== "number" || iat > now + 60) return null;      // 容忍 60s 时钟偏差
  if (exp - iat > MAX_TOKEN_LIFETIME_SEC) return null;             // 契约：最长 10 分钟
  if (!sub || !org) return null;

  return {
    sub: String(sub),
    org: String(org),
    orgRole: org_role === "org_admin" ? "org_admin" : "member",
    tier: typeof tier === "string" ? tier : "paid",
    ezplmProjectId: ezplm_project_id ? String(ezplm_project_id) : null,
  };
}

/* ---------- 本服务自己的会话 cookie（HMAC，照 admin-session 的写法） ---------- */

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function makeSessionCookieToken(claims: EzplmClaims): string {
  const secret = process.env.EZPLM_JWT_SECRET || "";
  const payload = Buffer.from(JSON.stringify({
    sub: claims.sub, org: claims.org, r: claims.orgRole,
    tier: claims.tier, pid: claims.ezplmProjectId ?? null,
    exp: Date.now() + SESSION_TTL_MS,
  })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionCookieToken(token: string | undefined): EzplmClaims | null {
  const secret = process.env.EZPLM_JWT_SECRET;
  if (!secret || !token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if (!safeEq(sig, sign(payload, secret))) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!d?.exp || d.exp < Date.now()) return null;
    if (!d.sub || !d.org) return null;
    return {
      sub: String(d.sub), org: String(d.org),
      orgRole: d.r === "org_admin" ? "org_admin" : "member",
      tier: typeof d.tier === "string" ? d.tier : "paid",
      ezplmProjectId: d.pid ?? null,
    };
  } catch { return null; }
}

/** cookie 属性：跨站嵌入必须 SameSite=None; Secure，同站部署用 Lax 更稳 */
export function sessionCookieOptions() {
  const crossSite = process.env.EMBED_CROSS_SITE === "1";
  return {
    httpOnly: true as const,
    sameSite: (crossSite ? "none" : "lax") as "none" | "lax",
    secure: crossSite || process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS / 1000,
    path: "/",
  };
}
