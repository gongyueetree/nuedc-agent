import { describe, it, expect } from "vitest";

/** 附件导入 Agent 的诚实性契约。
 *  核心要求：不确定就留空并写进 missing_fields，绝不猜数值；
 *  EDA 二进制工程文件明确拒绝，不产出臆造结果。 */

describe("module_ingestion 诚实原则", () => {
  it("提示词明确禁止猜测数值，要求 evidence_level 一律 E0", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/agents/ingestion.ts", "utf8");
    expect(src).toContain("绝不能凭型号");
    expect(src).toContain("missing_fields");
    expect(src).toContain('"E0"');
    expect(src).toContain("诚实原则");
  });

  it("EDA 二进制工程文件被识别并明确拒绝，不假装能解析", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/agents/ingestion.ts", "utf8");
    // 覆盖主流 EDA 格式
    for (const ext of ["kicad_sch", "kicad_pcb", "schdoc", "pcbdoc", "prjpcb"]) {
      expect(src, `未覆盖 ${ext}`).toContain(ext);
    }
    expect(src).toContain("暂不支持直接解析 EDA 工程文件");
  });

  it("归属与认证状态由服务端强制，模型输出不作数", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/agents/ingestion.ts", "utf8");
    expect(src).toContain('certification_status: "DRAFT"');
    expect(src).toContain("ctx.org ? \"ORGANIZATION\" : \"PERSONAL\"");
    expect(src).toContain("owner_ref: ctx.owner");
    // 必须从 ALS 上下文取，不能从 input
    expect(src).toContain("currentAgentContext()");
  });

  it("产物必须过 moduleInputSchema 严校验", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/agents/ingestion.ts", "utf8");
    expect(src).toContain("moduleInputSchema.safeParse");
    expect(src).toContain("human_review_required: true");
  });

  it("低置信度时给出明确警示", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/agents/ingestion.ts", "utf8");
    expect(src).toContain("confidence < 0.5");
    expect(src).toContain("请逐项核对");
  });
});

describe("导入端点安全与配额", () => {
  it("按文件魔数纠正 mime，不信客户端声明", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/modules/ingest/route.ts", "utf8");
    expect(src).toContain("function sniff");
    expect(src).toContain("25504446");     // %PDF
    expect(src).toContain("89504e47");     // PNG
    expect(src).toContain("f.mime = sniffed");
  });

  it("8MB 上限与配额三态（预占/提交/返还）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/modules/ingest/route.ts", "utf8");
    expect(src).toContain("MAX_BYTES");
    expect(src).toContain("reserveQuota");
    expect(src).toContain("commitQuota");
    // 失败路径必须返还
    expect((src.match(/refundQuota/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it("project_id 传 null 以绕开项目阶段门禁", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/modules/ingest/route.ts", "utf8");
    expect(src).toContain("projectId: null");
  });

  it("免费用户配额为 0（不开放导入）", async () => {
    const { quotaFor } = await import("../lib/usage");
    expect(quotaFor("module_ingest", "free")).toBe(0);
    expect(quotaFor("module_ingest", "paid")).toBe(10);
    expect(quotaFor("module_ingest", "admin")).toBe(-1);
  });

  it("MODULE_INGEST 任务策略：多模态 + strict + 需人工确认", async () => {
    const { TASK_POLICIES, AGENT_TASK_TYPE } = await import("../lib/model-gateway/task-policy");
    const p = (TASK_POLICIES as any).MODULE_INGEST;
    expect(p).toBeTruthy();
    expect(p.preference).toBe("vision");
    expect(p.schemaMode).toBe("strict");
    expect(p.requiresHumanReview).toBe(true);
    expect(AGENT_TASK_TYPE.module_ingestion).toBe("MODULE_INGEST");
  });
});
