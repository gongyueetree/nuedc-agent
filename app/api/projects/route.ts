import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema, uid } from "@/lib/db";
import { verifyTeamToken, TEAM_COOKIE } from "@/lib/team";
import { resolveOwner, withOwnerCookie, resolveTier } from "@/lib/auth";

export const runtime = "nodejs";
export async function OPTIONS() { return new NextResponse(null, { status: 204 }); }

export async function GET(req: NextRequest) {
  const includeTest = new URL(req.url).searchParams.get("include_test") === "1";
  await ensureSchema();
  const { owner, isNew } = resolveOwner(req);
  const tier = resolveTier(req);
  // 队伍隔离：加入队伍后看队伍的项目，否则只看本设备创建的（学生测试 P0-4）
  const team = verifyTeamToken(req.cookies.get(TEAM_COOKIE)?.value);
  // 严格按 owner 隔离；admin 可见全部（存量无主项目已由迁移 005 归属 admin:legacy）
  const rs = tier === "admin"
    // admin 默认也过滤掉测试数据；需要时用 ?include_test=1 查看
    ? await db().execute({
        sql: `SELECT project_id, name, stage, note, archived, ezplm_project_id, owner, updated_at
              FROM projects
              ${includeTest ? "" : "WHERE name NOT LIKE '\_\_%' AND name NOT LIKE '%压测%' AND name NOT LIKE 'E2E%'"}
              ORDER BY archived, updated_at DESC LIMIT 100`,
        args: [],
      })
    : await db().execute({
        sql: `SELECT project_id, name, stage, note, archived, ezplm_project_id, updated_at, created_by_name
              FROM projects
              WHERE ${team ? "team_ref=?" : "owner=? AND team_ref IS NULL"}
                AND name NOT LIKE '\_\_%' AND name NOT LIKE '%压测%' AND name NOT LIKE 'E2E%'
              ORDER BY archived, updated_at DESC LIMIT 50`,
        args: [team ? team.teamRef : owner],
      });
  return withOwnerCookie(NextResponse.json({ projects: rs.rows }), owner, isNew);
}

export async function POST(req: NextRequest) {
  try {
  await ensureSchema();
  const body = await req.json();
  const { owner, isNew } = resolveOwner(req);
  // 队伍归属：同队可见、跨队隔离（学生测试 P0-4）
  const team = verifyTeamToken(req.cookies.get(TEAM_COOKIE)?.value);
  const id = uid("P");
  await db().execute({
    // 记录队伍与创建人：队友能看到项目是谁建的，避免比赛期间互相覆盖
    sql: `INSERT INTO projects (project_id, name, problem_text, ezplm_project_id, owner, team_ref, created_by_name)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [id, body.name || "未命名电赛项目", body.problem_text || null, body.ezplm_project_id || null,
      owner, team?.teamRef ?? null, team?.member ?? null],
  });
  return withOwnerCookie(NextResponse.json({ project_id: id }, { status: 201 }), owner, isNew);
  } catch (e: any) {
    // 数据库不可用等基础故障：返回结构化错误，避免空响应让前端与压测无从判断
    return NextResponse.json({ error: `服务暂时不可用：${String(e?.message || e).slice(0, 200)}` }, { status: 503 });
  }
}
