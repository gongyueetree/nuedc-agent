import { describe, it, expect } from "vitest";
import { makeModuleId, toSlug, nextVariant } from "../lib/module-id";

/** P0-1：模块导入不得跨租户覆盖。
 *  此前 ingest 用 ON CONFLICT(id) DO UPDATE，模型输出的 id 直接作主键，
 *  组织 A 只要让模型输出 "mcu-mspm0g3507-lp" 就能覆盖公共模块。 */

const orgA = { scope: "ORGANIZATION", owner_ref: "ezplm:u1", org_ref: "ezplm:ws-aaa" };
const orgB = { scope: "ORGANIZATION", owner_ref: "ezplm:u9", org_ref: "ezplm:ws-bbb" };
const personU1 = { scope: "PERSONAL", owner_ref: "ezplm:u1", org_ref: null };
const personU2 = { scope: "PERSONAL", owner_ref: "ezplm:u2", org_ref: null };
const platform = { scope: "PUBLIC", owner_ref: "admin:1", org_ref: null };

describe("主键由服务端生成，租户天然隔离", () => {
  it("组织 A 无法生成组织 B 的主键", () => {
    const idA = makeModuleId("mcu-mspm0g3507-lp", orgA);
    const idB = makeModuleId("mcu-mspm0g3507-lp", orgB);
    expect(idA).not.toBe(idB);
    expect(idA).toMatch(/^org-[0-9a-f]{12,}-/);
    expect(idB).toMatch(/^org-[0-9a-f]{12,}-/);
  });

  it("组织模块无法与公共模块撞主键（不能覆盖公共库）", () => {
    const pub = makeModuleId("mcu-mspm0g3507-lp", platform);
    const org = makeModuleId("mcu-mspm0g3507-lp", orgA);
    expect(pub).toBe("mcu-mspm0g3507-lp");     // 公共库沿用 slug，既有引用不变
    expect(org).not.toBe(pub);
  });

  it("个人用户无法覆盖公共模块", () => {
    const pub = makeModuleId("ads1256-adc", platform);
    const usr = makeModuleId("ads1256-adc", personU1);
    expect(usr).not.toBe(pub);
    expect(usr).toMatch(/^usr-[0-9a-f]{12,}-/);
  });

  it("不同个人用户的同名模块主键不同", () => {
    expect(makeModuleId("my-board", personU1)).not.toBe(makeModuleId("my-board", personU2));
  });

  it("相同 suggested_id 在不同租户产生不同服务器主键", () => {
    const suggested = "sensor-bmp280-i2c";
    const ids = new Set([
      makeModuleId(suggested, orgA),
      makeModuleId(suggested, orgB),
      makeModuleId(suggested, personU1),
      makeModuleId(suggested, platform),
    ]);
    expect(ids.size).toBe(4);      // 四个租户各自独立
  });

  it("同一租户内同一 slug 稳定复现（便于检测冲突）", () => {
    expect(makeModuleId("abc", orgA)).toBe(makeModuleId("abc", orgA));
  });

  it("slug 规范化：清洗非法字符、限长、空值兜底", () => {
    expect(toSlug("MSPM0G3507 LaunchPad!!")).toBe("mspm0g3507-launchpad");
    expect(toSlug("   ")).toBe("module");
    expect(toSlug("a".repeat(200)).length).toBeLessThanOrEqual(48);
  });

  it("冲突变体不会跨出本租户命名空间", () => {
    const base = makeModuleId("x", orgA);
    const v = nextVariant(base, 0);
    expect(v.startsWith(base)).toBe(true);
    expect(v).toMatch(/^org-[0-9a-f]{12,}-/);
  });
});

describe("ingest 只允许 INSERT，冲突返回 409", () => {
  it("路由不再使用 ON CONFLICT DO UPDATE", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/modules/ingest/route.ts", "utf8");
    expect(src).not.toContain("ON CONFLICT");
    expect(src).not.toMatch(/DO UPDATE/i);
  });

  it("主键来自 makeModuleId 而非模型输出", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/modules/ingest/route.ts", "utf8");
    expect(src).toContain("makeModuleId(suggested");
    expect(src).toContain("绝不采用模型输出的 id");
    // 模型给的 id 只作为 suggested_id 留存
    expect(src).toContain("suggested_id: suggested");
  });

  it("重复插入返回 409 并提示改用 PATCH，同时返还配额", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/modules/ingest/route.ts", "utf8");
    const block = src.slice(src.indexOf("catch (e: any)"), src.indexOf("await commitQuota"));
    expect(block).toContain("status: 409");
    expect(block).toContain("PATCH /api/modules/");
    expect(block).toContain("refundQuota");        // 冲突不该扣配额
    expect(block).toContain("导入不会覆盖已有数据");
  });

  it("更新已有模块必须走 PATCH 并经过 canEditModule", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/modules/[id]/route.ts", "utf8");
    expect(src).toContain("canEditModule");
  });
});
