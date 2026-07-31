import { NextRequest, NextResponse } from "next/server";
import {
  generateTeamCode, normalizeTeamCode, makeTeamToken, verifyTeamToken,
  teamCookieOptions, TEAM_COOKIE,
} from "@/lib/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 当前队伍状态 */
export async function GET(req: NextRequest) {
  const t = verifyTeamToken(req.cookies.get(TEAM_COOKIE)?.value);
  return NextResponse.json({
    joined: !!t,
    code: t?.code ?? null,
    member: t?.member ?? null,
  });
}

/** 创建或加入队伍。
 *  队伍码是共享凭证 —— 队内成员输入同一个码即可看到同一批项目。
 *  这是 ezPLM SSO 就位前的过渡方案，不做强身份校验。 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "join");
  const member = String(body.member || "").trim().slice(0, 20) || null;

  if (action === "create") {
    const code = generateTeamCode();
    const res = NextResponse.json({
      ok: true, code, member,
      hint: "把这个队伍码发给队友，他们输入后就能看到同一批项目。请自行保管，丢失后无法找回。",
    });
    res.cookies.set(TEAM_COOKIE, makeTeamToken(code, member || undefined), teamCookieOptions());
    return res;
  }

  if (action === "leave") {
    const res = NextResponse.json({ ok: true, joined: false });
    res.cookies.set(TEAM_COOKIE, "", { ...teamCookieOptions(), maxAge: 0 });
    return res;
  }

  const code = normalizeTeamCode(body.code);
  if (!code) {
    return NextResponse.json({
      error: "队伍码格式不正确（4~12 位字母数字）",
    }, { status: 400 });
  }
  const res = NextResponse.json({ ok: true, code, member });
  res.cookies.set(TEAM_COOKIE, makeTeamToken(code, member || undefined), teamCookieOptions());
  return res;
}
