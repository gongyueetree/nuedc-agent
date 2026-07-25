import { createHmac, timingSafeEqual } from "node:crypto";

/** 管理后台短期会话令牌：HMAC(ADMIN_API_KEY) 签名，8 小时过期，
 *  经 httpOnly cookie 下发 —— 浏览器不再持有长期共享密钥。 */
export const ORG_ADMIN_COOKIE = "nuedc_admin_org";
export const ADMIN_COOKIE = "nuedc_admin";
export const ADMIN_TTL_MS = 8 * 3600 * 1000;

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
export function makeAdminToken(secret: string): string {
  const payload = Buffer.from(JSON.stringify({ r: "admin", exp: Date.now() + ADMIN_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}
export interface AdminSession {
  role: "admin" | "org_admin";
  /** org_admin 才有：其所属组织 */
  org?: string;
}

/** 解析管理会话。平台管理员与组织管理员共用同一套令牌格式，靠 r 字段区分。 */
export function readAdminSession(token: string | undefined, secret: string | undefined): AdminSession | null {
  if (!token || !secret) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expect = sign(payload, secret);
  try {
    const a = Buffer.from(sig), b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!(data.exp > Date.now())) return null;
    if (data.r === "admin") return { role: "admin" };
    if (data.r === "org_admin" && data.org) return { role: "org_admin", org: String(data.org) };
    return null;
  } catch { return null; }
}

/** 旧调用点的薄封装：只认平台管理员，行为与之前一致 */
export function verifyAdminToken(token: string | undefined, secret: string | undefined): boolean {
  return readAdminSession(token, secret)?.role === "admin";
}
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
