import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

/** 队伍身份。
 *
 *  学生测试报告（2026-07-28）P0-4：项目列表把所有人的项目混在一起，
 *  比赛期间会造成串改与信息泄露。
 *
 *  现状与取舍：完整账号体系要等 ezPLM SSO，短期内用「队伍码」过渡 ——
 *  一支队伍建一个码，队内成员输入同一个码即可共享项目，
 *  不同队伍互不可见。这比设备级 cookie 更贴近实际使用方式：
 *  三个队员用各自的笔记本，需要看到同一批项目。
 */

export const TEAM_COOKIE = "nuedc_team";
export const TEAM_TTL_MS = 30 * 24 * 3600 * 1000;   // 30 天，覆盖整个备赛周期

/** 队伍码格式：6 位大写字母数字，去掉易混淆的 0/O/1/I */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateTeamCode(): string {
  const bytes = randomBytes(6);
  return Array.from(bytes).map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function normalizeTeamCode(raw: string): string | null {
  const c = String(raw || "").trim().toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-Z0-9]{4,12}$/.test(c)) return null;
  return c;
}

/** 队伍标识用码的哈希，避免把明文码写进每条记录 */
export function teamRefOf(code: string): string {
  const secret = process.env.ADMIN_API_KEY || "nuedc-team-salt";
  return "team:" + createHmac("sha256", secret).update(code).digest("hex").slice(0, 16);
}

/* ---------- 会话 cookie ---------- */

function sign(payload: string): string {
  const secret = process.env.ADMIN_API_KEY || "nuedc-team-salt";
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function makeTeamToken(code: string, memberName?: string): string {
  const payload = Buffer.from(JSON.stringify({
    c: code,
    m: memberName || null,
    exp: Date.now() + TEAM_TTL_MS,
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export interface TeamSession {
  code: string;
  teamRef: string;
  member: string | null;
}

export function verifyTeamToken(token: string | undefined): TeamSession | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(sign(payload));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const d = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!d?.c || !d?.exp || d.exp < Date.now()) return null;
    const code = normalizeTeamCode(String(d.c));
    if (!code) return null;
    return { code, teamRef: teamRefOf(code), member: d.m ? String(d.m) : null };
  } catch {
    return null;
  }
}

export function teamCookieOptions() {
  const crossSite = process.env.EMBED_CROSS_SITE === "1";
  return {
    httpOnly: true as const,
    sameSite: (crossSite ? "none" : "lax") as "none" | "lax",
    secure: crossSite || process.env.NODE_ENV === "production",
    maxAge: TEAM_TTL_MS / 1000,
    path: "/",
  };
}
