import { NextRequest, NextResponse } from "next/server";
import { verifyEzplmToken, makeSessionCookieToken, sessionCookieOptions, SESSION_COOKIE } from "@/lib/ezplm-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ezPLM 嵌入入口：GET /api/session?token=<jwt>&next=/embed
 *  验签 → 下发会话 cookie → 302 到站内页面。
 *  iframe 无法传自定义头，这是把 ezPLM 身份带进本服务的唯一通道。 */
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const claims = verifyEzplmToken(sp.get("token"));
  if (!claims) {
    return NextResponse.json({ error: "登录令牌无效或已过期，请回到 ezPLM 重新进入" }, { status: 401 });
  }

  // 防开放重定向：只允许站内相对路径
  const raw = sp.get("next") || "/embed";
  const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/embed";

  const url = new URL(next, req.url);
  url.searchParams.set("embed", "1");
  if (claims.ezplmProjectId) url.searchParams.set("ezplmProjectId", claims.ezplmProjectId);

  const res = NextResponse.redirect(url, 302);
  res.cookies.set(SESSION_COOKIE, makeSessionCookieToken(claims), sessionCookieOptions());
  return res;
}

/** 查询当前会话（前端判断是否已登录、属于哪个组织） */
export async function POST(req: NextRequest) {
  const { getRequestIdentity } = await import("@/lib/identity");
  const id = await getRequestIdentity(req);
  return NextResponse.json({
    owner_masked: id.owner.slice(0, 14) + "…",
    tier: id.tier,
    org: id.org,
    org_role: id.orgRole,
    source: id.source,
  });
}
