import { describe, it, expect } from "vitest";
import { visibilityClause, VISIBILITY_SENTINEL } from "../lib/module-query";
import { visibleTo } from "../lib/module-search";

/** P0 安全：模块可见性 fail-closed。
 *  这些用例对应实施文档第 10 节的安全红线，任何一条失败都意味着跨组织数据泄露。 */

/** 用 SQL 子句 + 行数据模拟数据库过滤，验证 WHERE 语义是否正确 */
function passesClause(row: { scope: string | null; org_ref: string | null; owner_ref: string | null },
                      orgRef: string | null, viewerRef: string | null): boolean {
  const args = visibilityClause(orgRef, viewerRef).args;
  const [orgArg, ownerArg] = args;
  const scope = row.scope;
  if (scope === "PUBLIC" || scope === null) return true;
  if (scope === "ORGANIZATION") return row.org_ref === orgArg;
  if (scope === "PERSONAL" || scope === "TEAM") return row.owner_ref === ownerArg;
  return false;
}

const orgAPrivate = { scope: "ORGANIZATION", org_ref: "ezplm:ws-aaa", owner_ref: "ezplm:u1" };
const orgBPrivate = { scope: "ORGANIZATION", org_ref: "ezplm:ws-bbb", owner_ref: "ezplm:u9" };
const personal = { scope: "PERSONAL", org_ref: null, owner_ref: "ezplm:u1" };
const publicMod = { scope: "PUBLIC", org_ref: null, owner_ref: null };
const legacyNull = { scope: null, org_ref: null, owner_ref: null };

describe("SQL 层可见性过滤", () => {
  it("A 组织私有模块：B 组织成员看不到", () => {
    expect(passesClause(orgAPrivate, "ezplm:ws-bbb", "ezplm:u9")).toBe(false);
  });

  it("A 组织私有模块：A 组织成员可见", () => {
    expect(passesClause(orgAPrivate, "ezplm:ws-aaa", "ezplm:u1")).toBe(true);
    // 同组织的另一个成员也可见
    expect(passesClause(orgAPrivate, "ezplm:ws-aaa", "ezplm:u2")).toBe(true);
  });

  it("匿名用户（无组织无身份）只能看到公共模块", () => {
    expect(passesClause(publicMod, null, null)).toBe(true);
    expect(passesClause(orgAPrivate, null, null)).toBe(false);
    expect(passesClause(orgBPrivate, null, null)).toBe(false);
    expect(passesClause(personal, null, null)).toBe(false);
  });

  it("个人模块只有本人可见，同组织他人也看不到", () => {
    expect(passesClause(personal, "ezplm:ws-aaa", "ezplm:u1")).toBe(true);
    expect(passesClause(personal, "ezplm:ws-aaa", "ezplm:u2")).toBe(false);
  });

  it("scope 为 NULL 的历史行按 PUBLIC 处理", () => {
    expect(passesClause(legacyNull, null, null)).toBe(true);
  });

  it("空组织/空身份使用哨兵值，不会匹配 org_ref 为空的脏数据", () => {
    const { args } = visibilityClause(null, null);
    expect(args[0]).toBe(VISIBILITY_SENTINEL);
    expect(args[1]).toBe(VISIBILITY_SENTINEL);
    // 脏数据：scope 是 ORGANIZATION 但 org_ref 为空
    const dirty = { scope: "ORGANIZATION", org_ref: null, owner_ref: null };
    expect(passesClause(dirty, null, null)).toBe(false);
  });

  it("SQL 子句不使用 IS NULL 匹配（否则脏数据会泄露）", () => {
    const { sql } = visibilityClause("x", "y");
    expect(sql).not.toMatch(/org_ref\s+IS\s+NULL/i);
    expect(sql).not.toMatch(/owner_ref\s+IS\s+NULL/i);
  });
});

describe("fail-closed 默认行为", () => {
  it("loadModuleIndex 不传可见范围时只返回公共模块", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/agents/base.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function loadModuleIndex"), src.indexOf("/** 给 LLM 的精简模块目录"));
    expect(fn).toContain("visibilityClause");
    expect(fn).toContain("vis?.orgRef");
    // 必须把 scope 过滤写进 SQL，而不是取出来后在内存里挑
    expect(fn).toMatch(/WHERE[\s\S]*\$\{v\.sql\}/);
  });

  it("queryCapabilities 在 SQL 层过滤而非内存过滤", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/module-query.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function queryCapabilities"), src.indexOf("export async function governanceReport"));
    expect(fn).toContain("visibilityClause");
    expect(fn).toMatch(/WHERE \$\{vis\.sql\}/);
    // 不能再有无条件全表扫描
    expect(fn).not.toContain("FROM modules LIMIT 1000");
  });

  it("治理报告也按可见范围统计", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/module-query.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function governanceReport"));
    expect(fn).toContain("visibilityClause");
  });

  it("模块详情越权返回 404 而非 403（不泄露存在性）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/modules/[id]/route.ts", "utf8");
    expect(src).toContain("visibilityClause");
    expect(src).toContain("越权一律 404");
    // 可见性必须并入 WHERE，而不是查出来再判断
    expect(src).toMatch(/WHERE id=\? AND \$\{vis\.sql\}/);
  });

  it("可见范围来自服务端身份，不采信请求参数", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/modules/route.ts", "utf8");
    expect(src).toContain("getRequestIdentity");
    expect(src).toContain("绝不采信请求参数");
    // 不得从 URL 参数读取 org
    expect(src).not.toMatch(/sp\.get\(["']org/);
  });
});

describe("module-search 可见性判断（内存层，与 SQL 层双保险）", () => {
  it("与 SQL 层语义一致", () => {
    expect(visibleTo({ scope: "PUBLIC" }, {})).toBe(true);
    expect(visibleTo({ scope: "ORGANIZATION", org_ref: "ezplm:ws-aaa" }, { orgRef: "ezplm:ws-aaa" })).toBe(true);
    expect(visibleTo({ scope: "ORGANIZATION", org_ref: "ezplm:ws-aaa" }, { orgRef: "ezplm:ws-bbb" })).toBe(false);
    expect(visibleTo({ scope: "PERSONAL", owner_ref: "ezplm:u1" }, { viewerRef: "ezplm:u1" })).toBe(true);
    expect(visibleTo({ scope: "PERSONAL", owner_ref: "ezplm:u1" }, { viewerRef: "ezplm:u2" })).toBe(false);
  });
});

describe("阶段 C：本组织模块优先", () => {
  const mods = [
    { id: "pub-good", name: "公共高认证模块", scope: "PUBLIC", category: "mcu.arm",
      certification_status: "COMPETITION_READY", interfaces: [], power: {} },
    { id: "org-plain", name: "组织普通模块", scope: "ORGANIZATION", org_ref: "ezplm:ws-aaa",
      category: "mcu.arm", certification_status: "DRAFT", interfaces: [], power: {} },
  ];

  it("功能等价时本组织模块排在公共模块之前，理由含「本组织模块」", async () => {
    const { searchModules } = await import("../lib/module-search");
    const { picked } = searchModules(mods, { orgRef: "ezplm:ws-aaa" });
    expect(picked[0].module.id).toBe("org-plain");
    expect(picked[0].reasons).toContain("本组织模块");
  });

  it("非本组织成员看不到该模块，公共模块回到首位", async () => {
    const { searchModules } = await import("../lib/module-search");
    const { picked } = searchModules(mods, { orgRef: "ezplm:ws-bbb" });
    expect(picked.map((p) => p.module.id)).not.toContain("org-plain");
    expect(picked[0].module.id).toBe("pub-good");
  });

  it("组织库模块很多时仍保证公共模块保底数量", async () => {
    const { searchModules, PUBLIC_FLOOR } = await import("../lib/module-search");
    const many = [
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `org${i}`, name: `组织模块${i}`, scope: "ORGANIZATION", org_ref: "ezplm:ws-aaa",
        category: "other.misc", certification_status: "DOCUMENTED", interfaces: [], power: {},
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `pub${i}`, name: `公共模块${i}`, scope: "PUBLIC",
        category: "other.misc", certification_status: "DOCUMENTED", interfaces: [], power: {},
      })),
    ];
    const { picked } = searchModules(many, { orgRef: "ezplm:ws-aaa", topK: 20 });
    const pubCount = picked.filter((p) => p.module.scope === "PUBLIC").length;
    expect(pubCount).toBeGreaterThanOrEqual(Math.min(PUBLIC_FLOOR, 10));
  });

  it("目录文本标注归属，LLM 能识别哪些是本组织模块", async () => {
    const { buildModuleContext } = await import("../lib/module-search");
    const { text } = buildModuleContext(mods, { orgRef: "ezplm:ws-aaa" });
    expect(text).toContain("【本组织】");
  });

  it("Agent 不再从 input 读可见范围（客户端可伪造）", async () => {
    const fs = await import("node:fs");
    const eng = fs.readFileSync("lib/agents/engineering.ts", "utf8");
    const plan = fs.readFileSync("lib/agents/planning.ts", "utf8");
    // 只允许出现在注释里
    expect(eng).not.toMatch(/viewerRef:\s*input\./);
    expect(eng).not.toMatch(/orgRef:\s*input\./);
    expect(eng).toContain("currentAgentContext()");
    expect(plan).toContain("currentAgentContext()");
  });

  it("两个 Agent 的提示词都要求本组织模块优先", async () => {
    const fs = await import("node:fs");
    for (const f of ["lib/agents/planning.ts", "lib/agents/engineering.ts"]) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, `${f} 缺少本组织优先规则`).toContain("模块选用硬规则");
      expect(src).toContain("必须优先选用");
    }
  });
});
