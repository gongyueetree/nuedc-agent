import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/module-query";
import { db, ensureSchema } from "@/lib/db";
import { moduleUpdateSchema, zodMessage } from "@/lib/module-schema";
import { resolveTier, canDownloadAssets, canReviewModules, stripPaidFields } from "@/lib/auth";
import type { ModuleCertState } from "@/lib/types";

export const runtime = "nodejs";
export async function OPTIONS() { return new NextResponse(null, { status: 204 }); }

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  await ensureSchema();
  const tier = resolveTier(req);
  const { getRequestIdentity } = await import("@/lib/identity");
  const id = await getRequestIdentity(req);
  const { visibilityClause } = await import("@/lib/module-query");
  const vis = visibilityClause((id as any).org ?? null, id.owner);
  // 越权一律 404 而非 403：403 会泄露"这个模块存在"
  const rs = await db().execute({
    sql: `SELECT data, certification_status, downloads FROM modules WHERE id=? AND ${vis.sql}`,
    args: [params.id, ...vis.args],
  });
  if (!rs.rows.length) return NextResponse.json({ error: "模块不存在" }, { status: 404 });
  const data = JSON.parse(String(rs.rows[0].data));
  const cert = String(rs.rows[0].certification_status) as ModuleCertState;
  const unlocked = canDownloadAssets(tier, cert);
  if (unlocked) {
    await db().execute({ sql: "UPDATE modules SET downloads = downloads + 1 WHERE id=?", args: [params.id] });
  }
  await audit("edit", params.id, tier);
  return NextResponse.json({ module: unlocked ? data : stripPaidFields(data), tier });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const tier = resolveTier(req);
  // 权限按「谁拥有这个模块」判定，而非只看 tier —— 组织管理员应能改本组织模块
  const { getRequestIdentity } = await import("@/lib/identity");
  const { canEditModule } = await import("@/lib/module-acl");
  const editId = await getRequestIdentity(req);
  const cur = await db().execute({
    sql: "SELECT scope, owner_ref, org_ref, certification_status FROM modules WHERE id=?",
    args: [params.id],
  });
  // 模块不存在、或无权编辑，一律 404（不泄露存在性）
  if (!cur.rows.length) return NextResponse.json({ error: "模块不存在" }, { status: 404 });
  const row: any = cur.rows[0];
  if (!canEditModule(editId, {
    scope: row.scope ? String(row.scope) : null,
    owner_ref: row.owner_ref ? String(row.owner_ref) : null,
    org_ref: row.org_ref ? String(row.org_ref) : null,
  })) {
    return NextResponse.json({ error: "模块不存在" }, { status: 404 });
  }
  await ensureSchema();
  const body = await req.json();
  const parsed = moduleUpdateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  const rs = await db().execute({ sql: "SELECT data FROM modules WHERE id=?", args: [params.id] });
  if (!rs.rows.length) return NextResponse.json({ error: "模块不存在" }, { status: 404 });
  const merged = { ...JSON.parse(String(rs.rows[0].data)), ...parsed.data };
  await db().execute({
    sql: "UPDATE modules SET name=?, category=?, version=?, price=?, data=?, updated_at=now() WHERE id=?",
    args: [merged.name, merged.category, merged.version, merged.price ?? 0, JSON.stringify(merged), params.id],
  });
  return NextResponse.json({ ok: true });
}
