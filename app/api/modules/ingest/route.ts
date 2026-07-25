import { NextRequest, NextResponse } from "next/server";
import "@/lib/agents/index";
import { runAgent } from "@/lib/agents/base";
import { getRequestIdentity, withIdentityCookie } from "@/lib/identity";
import { reserveQuota, commitQuota, refundQuota } from "@/lib/usage";
import { canCreateModule } from "@/lib/module-acl";
import { db, ensureSchema } from "@/lib/db";
import { audit } from "@/lib/module-query";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_BYTES = 8 * 1024 * 1024;

/** 文件魔数校验：不能只信客户端声明的 mime */
function sniff(b64: string): string | null {
  const head = Buffer.from(b64.slice(0, 32), "base64");
  const hex = head.subarray(0, 4).toString("hex").toLowerCase();
  if (hex.startsWith("25504446")) return "application/pdf";      // %PDF
  if (hex.startsWith("89504e47")) return "image/png";
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (hex.startsWith("52494646")) return "image/webp";
  return null;
}

/** POST /api/modules/ingest
 *  从工程文件附件生成模块草稿。ezPLM 侧由后端携 EZPLM_API_KEY + X-User-Id + X-Org-Id 代理调用，
 *  附件不需要公网可达。 */
export async function POST(req: NextRequest) {
  const id = await getRequestIdentity(req);
  if (!canCreateModule(id)) {
    return NextResponse.json({ error: "需要登录后才能导入模块" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const files: any[] = Array.isArray(body?.files) ? body.files : [];
  if (!files.length) return NextResponse.json({ error: "需要 { files: [{ name, mime, data_base64 }] }" }, { status: 400 });

  let total = 0;
  for (const f of files) {
    if (!f?.data_base64) return NextResponse.json({ error: `文件 ${f?.name || "?"} 缺少内容` }, { status: 400 });
    total += Math.floor(String(f.data_base64).length * 0.75);
    if (total > MAX_BYTES) {
      return NextResponse.json({ error: `附件总大小超过 ${MAX_BYTES / 1024 / 1024}MB 上限` }, { status: 413 });
    }
    // 二进制类文件按魔数纠正 mime，防止伪装
    const sniffed = sniff(String(f.data_base64));
    if (sniffed) f.mime = sniffed;
  }

  // 配额：预占 → 成功提交 → 失败返还
  const { reservation, error: qerr } = await reserveQuota(id.owner, "module_ingest", id.tier);
  if (!reservation) return NextResponse.json({ error: qerr }, { status: 429 });

  try {
    // project_id 传 null：导入不属于任何项目，绕开项目阶段门禁
    const result = await runAgent("module_ingestion" as any, { files, hint: body?.hint }, {
      projectId: null, stage: "PREPARATION", tier: id.tier,
      owner: id.owner, org: id.org, orgRole: id.orgRole,
    });

    if (!result.ok) {
      await refundQuota(id.owner, "module_ingest", reservation.ref);
      return NextResponse.json({ error: result.message, issues: (result as any).issues }, { status: 422 });
    }

    const out: any = result.output;
    const mod = out.module;

    await ensureSchema();
    // 落库为草稿，归属已在 Agent 内按身份强制
    await db().execute({
      sql: `INSERT INTO modules (id, name, category, version, certification_status, source_type, price, data,
              scope, owner_ref, org_ref)
            VALUES (?,?,?,?, 'DRAFT', 'ingest', ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=now()`,
      args: [mod.id, mod.name, mod.category, mod.version || "1.0.0", mod.price ?? null,
        JSON.stringify(mod), mod.scope, mod.owner_ref, mod.org_ref],
    });

    await commitQuota(reservation.ref);
    await audit("ingest", mod.id, id.owner).catch(() => {});

    return withIdentityCookie(NextResponse.json({
      module_id: mod.id,
      confidence: out.confidence,
      missing_fields: out.missing_fields,
      notes: out.notes,
      skipped_files: out.skipped_files,
      message: result.message,
      human_review_required: true,
    }, { status: 201 }), id);
  } catch (e: any) {
    await refundQuota(id.owner, "module_ingest", reservation.ref);
    return NextResponse.json({ error: `导入失败：${String(e?.message || e).slice(0, 200)}。本次不计入配额。` }, { status: 500 });
  }
}
