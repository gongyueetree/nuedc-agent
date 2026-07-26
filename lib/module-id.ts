import { createHash } from "node:crypto";

/** 模块主键生成。
 *
 *  为什么不能用模型输出的 id 做主键：
 *  导入功能让模型生成 id，若直接作主键并允许 UPSERT，
 *  组织 A 只要让模型输出 "mcu-mspm0g3507-lp" 就能覆盖公共模块或他人模块。
 *
 *  策略：服务端按归属加命名空间前缀。
 *  - 公共库（平台维护）：沿用原始 slug，保持既有引用不变
 *  - 组织模块：org-<组织哈希6>-<slug>
 *  - 个人模块：usr-<用户哈希6>-<slug>
 *  前缀由服务端身份决定，组织 A 无法生成组织 B 前缀的主键，租户天然隔离。 */

const SLUG_MAX = 48;

export function toSlug(raw: string): string {
  const s = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX);
  return s || "module";
}

/** 租户命名空间长度。
 *  6 位十六进制只有 2^24 空间，按生日悖论约 4000 个租户就有 ~1/1000 碰撞概率；
 *  碰撞意味着两个组织共用主键前缀，可能互相覆盖模块。取 16 位（64 bit）。 */
const NS_HEX_LEN = 16;

function ns(ref: string): string {
  return createHash("sha256").update(ref).digest("hex").slice(0, NS_HEX_LEN);
}

export { NS_HEX_LEN };

export interface OwnershipRef {
  scope: string;
  owner_ref: string;
  org_ref?: string | null;
}

/** 生成服务端权威主键。同一 slug 在不同组织下必然得到不同主键。 */
export function makeModuleId(suggested: string, own: OwnershipRef): string {
  const slug = toSlug(suggested);
  if (own.scope === "PUBLIC") return slug;
  if (own.scope === "ORGANIZATION" && own.org_ref) return `org-${ns(own.org_ref)}-${slug}`;
  return `usr-${ns(own.owner_ref)}-${slug}`;
}

/** 冲突时的候选主键：追加短序号，供调用方在同租户内重试 */
export function nextVariant(baseId: string, attempt: number): string {
  return `${baseId}-${attempt + 1}`;
}
