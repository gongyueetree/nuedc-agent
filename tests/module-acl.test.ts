import { describe, it, expect } from "vitest";
import {
  canCreateModule, defaultScopeFor, canUseScope, canEditModule,
  canReviewModule, maxPromotableState, canPromoteTo, resolveOwnership,
} from "../lib/module-acl";
import type { Identity } from "../lib/identity";

const mk = (o: Partial<Identity>): Identity => ({
  owner: "anon:x", tier: "free", org: null, orgRole: null,
  source: "anonymous", isNewOwner: false, ...o,
} as Identity);

const platformAdmin = mk({ tier: "admin", owner: "admin:1" });
const platformLab = mk({ tier: "lab", owner: "lab:1" });
const orgAdminA = mk({ tier: "paid", owner: "ezplm:u1", org: "ezplm:ws-aaa", orgRole: "org_admin", source: "ezplm_session" });
const memberA = mk({ tier: "paid", owner: "ezplm:u2", org: "ezplm:ws-aaa", orgRole: "member", source: "ezplm_session" });
const orgAdminB = mk({ tier: "paid", owner: "ezplm:u9", org: "ezplm:ws-bbb", orgRole: "org_admin", source: "ezplm_session" });
const anon = mk({});

const modOrgA = { id: "m1", scope: "ORGANIZATION", org_ref: "ezplm:ws-aaa", owner_ref: "ezplm:u1" };
const modOrgB = { id: "m2", scope: "ORGANIZATION", org_ref: "ezplm:ws-bbb", owner_ref: "ezplm:u9" };
const modPublic = { id: "m3", scope: "PUBLIC", org_ref: null, owner_ref: null };
const modPersonalU2 = { id: "m4", scope: "PERSONAL", org_ref: null, owner_ref: "ezplm:u2" };

describe("默认可见范围", () => {
  it("平台人员建的是公共模块，组织用户建的是组织模块，散户建个人模块", () => {
    expect(defaultScopeFor(platformAdmin)).toBe("PUBLIC");
    expect(defaultScopeFor(orgAdminA)).toBe("ORGANIZATION");
    expect(defaultScopeFor(memberA)).toBe("ORGANIZATION");
    expect(defaultScopeFor(mk({ tier: "paid", owner: "u" }))).toBe("PERSONAL");
  });

  it("组织用户不得创建 PUBLIC 模块", () => {
    expect(canUseScope(orgAdminA, "PUBLIC")).toBe(false);
    expect(canUseScope(memberA, "PUBLIC")).toBe(false);
    expect(canUseScope(platformLab, "PUBLIC")).toBe(true);
  });

  it("无组织者不得创建 ORGANIZATION 模块", () => {
    expect(canUseScope(anon, "ORGANIZATION")).toBe(false);
    expect(canUseScope(memberA, "ORGANIZATION")).toBe(true);
  });
});

describe("归属字段服务端权威", () => {
  it("客户端伪造 PUBLIC 会被降级为默认范围", () => {
    const r = resolveOwnership(orgAdminA, "PUBLIC");
    expect(r.scope).toBe("ORGANIZATION");        // 不是 PUBLIC
    expect(r.org_ref).toBe("ezplm:ws-aaa");
    expect(r.owner_ref).toBe("ezplm:u1");
  });

  it("组织模块的 org_ref 只能是自己的组织", () => {
    // 即便客户端在请求体里写了别的组织，也取不到——org_ref 来自 identity
    const r = resolveOwnership(memberA, "ORGANIZATION");
    expect(r.org_ref).toBe("ezplm:ws-aaa");
  });

  it("个人模块不带 org_ref", () => {
    expect(resolveOwnership(memberA, "PERSONAL").org_ref).toBeNull();
  });
});

describe("编辑权限", () => {
  it("平台人员可编辑任何模块", () => {
    for (const m of [modOrgA, modOrgB, modPublic]) {
      expect(canEditModule(platformAdmin, m)).toBe(true);
      expect(canEditModule(platformLab, m)).toBe(true);
    }
  });

  it("组织管理员只能编辑本组织模块", () => {
    expect(canEditModule(orgAdminA, modOrgA)).toBe(true);
    expect(canEditModule(orgAdminA, modOrgB)).toBe(false);   // 跨组织
    expect(canEditModule(orgAdminA, modPublic)).toBe(false); // 公共库
  });

  it("普通成员不能编辑组织模块，但能编辑自己的个人模块", () => {
    expect(canEditModule(memberA, modOrgA)).toBe(false);
    expect(canEditModule(memberA, modPersonalU2)).toBe(true);
  });

  it("他人的个人模块不可编辑", () => {
    expect(canEditModule(orgAdminA, modPersonalU2)).toBe(false);
  });

  it("匿名用户什么都不能编辑", () => {
    for (const m of [modOrgA, modPublic, modPersonalU2]) {
      expect(canEditModule(anon, m)).toBe(false);
    }
  });
});

describe("认证晋级上限", () => {
  it("组织管理员封顶 FUNCTION_TESTED", () => {
    expect(maxPromotableState(orgAdminA, modOrgA)).toBe("FUNCTION_TESTED");
    expect(canPromoteTo(orgAdminA, modOrgA, "FUNCTION_TESTED")).toBe(true);
    expect(canPromoteTo(orgAdminA, modOrgA, "BENCHMARKED")).toBe(false);
    expect(canPromoteTo(orgAdminA, modOrgA, "COMPETITION_READY")).toBe(false);
  });

  it("平台人员可晋级到最高级", () => {
    expect(maxPromotableState(platformLab, modPublic)).toBe("COMPETITION_READY");
    expect(canPromoteTo(platformLab, modPublic, "COMPETITION_READY")).toBe(true);
  });

  it("跨组织无法审核", () => {
    expect(canReviewModule(orgAdminB, modOrgA)).toBe(false);
    expect(canPromoteTo(orgAdminB, modOrgA, "FUNCTION_TESTED")).toBe(false);
  });

  it("普通成员无审核权", () => {
    expect(canReviewModule(memberA, modOrgA)).toBe(false);
  });
});

describe("创建权限", () => {
  it("组织成员与付费用户可创建，匿名不可", () => {
    expect(canCreateModule(memberA)).toBe(true);
    expect(canCreateModule(mk({ tier: "paid", owner: "u" }))).toBe(true);
    expect(canCreateModule(platformLab)).toBe(true);
    expect(canCreateModule(anon)).toBe(false);
  });
});

describe("阶段 E：组织管理后台", () => {
  it("admin-session 支持平台管理员与组织管理员两种角色", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/admin-session.ts", "utf8");
    expect(src).toContain("readAdminSession");
    expect(src).toContain('role: "admin" | "org_admin"');
    // 旧调用点的薄封装必须保留且只认平台管理员
    expect(src).toContain("export function verifyAdminToken");
    expect(src).toContain('readAdminSession(token, secret)?.role === "admin"');
  });

  it("组织管理员登录端点要求 org_role=org_admin，不暴露 ADMIN_API_KEY", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/admin/session/ezplm/route.ts", "utf8");
    expect(src).toContain("verifyEzplmToken");
    expect(src).toContain('claims.orgRole !== "org_admin"');
    expect(src).toContain("ORG_ADMIN_COOKIE");
    // 登录靠 ezPLM 签发的 JWT，而不是让组织用户拿平台密钥
    expect(src).not.toMatch(/body\.key|ADMIN_API_KEY\s*===/);
  });

  it("后台按归属分组，org_admin 隐藏平台级页签", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/AdminClient.tsx", "utf8");
    expect(src).toContain("scopeTab");
    expect(src).toContain("本组织");
    expect(src).toContain('orgInfo.role !== "org_admin"');   // 分类管理/数据治理条件渲染
    expect(src).toContain("可见范围");
  });

  it("组织管理员会话产生 paid 层身份而非平台 admin", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/identity.ts", "utf8");
    const seg = src.slice(src.indexOf("组织管理员（后台会话）"));
    expect(seg).toContain('tier: "paid"');
    expect(seg).not.toContain('tier: "admin"');
  });
});
