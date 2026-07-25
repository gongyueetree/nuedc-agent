import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "node:crypto";
import { verifyEzplmToken } from "@/lib/ezplm-session";
import { ORG_ADMIN_COOKIE } from "@/lib/admin-session";

export const runtime = "nodejs";

const TTL_MS = 8 * 3600 * 1000;

/** ezPLM 组织管理员登录后台。
 *  用 ezPLM 签发的 JWT 换取本服务的管理会话，
 *  这样组织用户无需知道 ADMIN_API_KEY 也能管理本组织模块。 */
export async function POST(req: NextRequest) {
  const { token } = await req.json().catch(() => ({}));
  const claims = verifyEzplmToken(token);
  if (!claims) {
    return NextResponse.json({ error: "登录令牌无效或已过期" }, { status: 401 });
  }
  if (claims.orgRole !== "org_admin") {
    return NextResponse.json({ error: "需要组织管理员权限" }, { status: 403 });
  }

  const secret = process.env.ADMIN_API_KEY;
  if (!secret) return NextResponse.json({ error: "服务端未配置管理密钥" }, { status: 500 });

  const payload = Buffer.from(JSON.stringify({
    r: "org_admin", org: `ezplm:${claims.org}`, sub: claims.sub, exp: Date.now() + TTL_MS,
  })).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");

  const res = NextResponse.json({ ok: true, role: "org_admin", org: `ezplm:${claims.org}` });
  res.cookies.set(ORG_ADMIN_COOKIE, `${payload}.${sig}`, {
    httpOnly: true,
    sameSite: process.env.EMBED_CROSS_SITE === "1" ? "none" : "lax",
    secure: process.env.EMBED_CROSS_SITE === "1" || process.env.NODE_ENV === "production",
    maxAge: TTL_MS / 1000,
    path: "/",
  });
  return res;
}
