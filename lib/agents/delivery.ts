// 交付类 Agent：代码生成、LabSight 调试、报告生成 + 总控编排
import { llmComplete, llmJson } from "../llm";
import { codeFileSchema, parseArrayLoose } from "../agent-schemas";
import { registerAgent, loadModuleIndex, sawPartial } from "./base";
import type { SolutionProposal } from "../types";

// ============ Agent 11：代码生成（Code Generation）============
// 模块级生成，不一次性生成整个工程；未验证代码不得标记"可用"
registerAgent("code_generator", async (input, ctx) => {
  const solution: SolutionProposal | undefined = input.solution;
  const target: string = input.target_module || "";
  if (!solution && !target) return { ok: false, output: null, message: "请提供 solution 或 target_module（要生成哪个模块的代码）" };

  const index = await loadModuleIndex();
  const relatedModules = (solution?.blocks || [])
    .map((b) => (b.module_id ? index[b.module_id] : null))
    .filter(Boolean);

  const out = await llmJson<{
    plan: { layer: string; files: string[] }[];
    files: { path: string; language: string; content: string; notes: string }[];
    integration_notes: string[];
    unsupported_items: string[];
  }>({
    system: `你是电赛嵌入式代码生成专家。规则：
1. 模块级生成：一次只生成一个功能模块的驱动/服务层代码（如 UART 协议、PID、传感器驱动），不生成整个工程
2. 遵循分层结构 firmware/{bsp,drivers,middleware,algorithms,services,app,config}
3. 代码含中文注释、引脚映射来自方案 connections、协议帧格式明确定义
4. 关于 SDK API 的边界（务必区分）：
   - 官方文档化的 SDK API【放心使用】：TI MSPM0 driverlib（DL_GPIO_*/DL_SPI_*/DL_ADC12_*/DL_SYSCTL_* 等）、
     STM32 HAL（HAL_*）、ESP-IDF —— 这些是公开 SDK，使用它们是正确做法，不是编造
   - SysConfig 生成物（ti_msp_dl_config.h、gSPI0_config、SPI0_INST 等实例宏）：直接 #include "ti_msp_dl_config.h"
     并正常调用 SYSCFG_DL_init()；在 notes 注明"引脚/外设实例需在 SysConfig 中按连线表配置后重新生成"
   - 只有【你自己发明的、任何文档都不存在的函数名】才算编造，才放 unsupported_items
5. files 必须非空：至少输出该模块完整可编译的 .c/.h 文件（含 main 或明确的对外接口）
6. 输出的每个文件在 notes 里写明"需要人工验证的点"
7. 【代码从哪来】你直接依据芯片官方 SDK 的公开 API 编写实现，不是从模块库复制 ——
   模块库只提供引脚/接口/注意事项等约束信息，驱动逻辑由你按 SDK 规范生成
目标芯片/工具链：${input.toolchain || "MSPM0G3507 + TI SysConfig/CCS（默认）"}

输出格式（严格遵守，files 至少 2 项且 content 非空）：
{"plan":[{"layer":"drivers","files":["xxx.c","xxx.h"]}],
 "files":[{"path":"firmware/drivers/xxx.c","language":"c","content":"#include ...\n完整代码","notes":"需人工验证：引脚需在 SysConfig 中配置"}],
 "integration_notes":["..."],"unsupported_items":[]}`,
    messages: [
      {
        role: "user",
        content: `请为下面这个功能模块生成可编译的固件代码。

【目标模块】${target || "（方案中的主控模块）"}
【所属方案】${solution?.name || "未命名"}
【该模块在方案中的连线】
${(solution?.connections || [])
  .filter((c: any) => !target || `${c.from} ${c.to}`.toLowerCase().includes(String(target).toLowerCase().slice(0, 8)))
  .map((c: any) => `- ${c.from} → ${c.to}（${c.protocol}${c.baudrate ? ` @${c.baudrate}` : ""}，${c.voltage_from}V→${c.voltage_to}V）`)
  .join("\n") || "（连线表未提供，请按常规接法生成并在 notes 注明假设）"}
【方案全部功能块】
${(solution?.blocks || []).map((b: any) => `- ${b.block_id} ${b.name}${b.module_id ? `（${b.module_id}）` : ""}`).join("\n") || "无"}
【相关模块库资料】
${JSON.stringify(relatedModules.map((m: any) => ({ id: m.id, name: m.name, interfaces: m.interfaces, usage_notes: m.usage_notes }))).slice(0, 3000)}
【补充要求】${input.notes || "无"}

必须输出至少 2 个文件（如 xxx.c + xxx.h，或 main.c + 驱动文件），每个文件内容完整可编译。`,
      },
    ],
    maxTokens: 10240,
  });

  // 运行时校验 + 空文件不算成功
  const { data: files, dropped } = parseArrayLoose(codeFileSchema, out.files);
  if (!files.length) {
    return { ok: false, output: null, message: "模型未生成任何代码文件（可能把全部 SDK 调用误判为不可生成）。请重试；反复出现请反馈。" };
  }
  const codePartial = sawPartial();
  return {
    ok: true,
    artifact_type: "code_bundle",
    output: {
      ...out, files, verification_status: "GENERATED",
      dropped_files: dropped, partial_output: codePartial, repair_applied: codePartial,
    },
    human_review_required: true,
    message: `已生成 ${files.length} 个文件（状态 GENERATED，编译通过前不得标记为可用）` +
      (codePartial ? "。⚠ 输出曾被截断修复，末尾文件可能不完整，请先运行静态验证" : "") +
      (dropped ? `。已剔除 ${dropped} 个结构异常的文件` : ""),
  };
});

// ============ Agent 13：LabSight 调试（Debug Agent）============
// 输入：现象描述 + 可选 PCB 照片（base64）+ 串口日志；输出：故障树 + 下一步测量动作
registerAgent("labsight_debug", async (input) => {
  const symptom: string = input.symptom || "";
  if (!symptom) return { ok: false, output: null, message: "请描述故障现象 symptom" };

  const images = (input.images || []) as { media_type: string; data_base64: string }[];

  const out = await llmJson<{
    symptom: string;
    observations: string[];
    hypotheses: { cause: string; confidence: number; evidence: string[] }[];
    next_actions: { instrument: string; probe_point: string; expect: string; note: string }[];
    safety_warnings: string[];
  }>({
    system: `你是电赛实验室调试专家（LabSight Debug Agent）。规则：
1. 建立故障树：按置信度排序的假设列表，每个假设附证据
2. next_actions 给出具体测量动作：用什么仪器、测哪个点、预期看到什么
3. 如提供了 PCB 照片，先做目视检查：器件方向、焊接、短路、飞线
4. 涉及市电/高压/大功率时必须输出 safety_warnings，禁止指导徒手测量带电高压
5. 常见套路要覆盖：电源跌落复位、UART 波特率/晶振、PWM 未输出（Timer/复用/时钟）、I2C 无应答（地址/上拉/电平）
6. 这是循环调试：基于新测量结果更新假设，不是一次性问答`,
    messages: [
      {
        role: "user",
        content: `故障现象：${symptom}
串口日志/测量数据：${(input.logs || "无").slice(0, 4000)}
系统上下文：${JSON.stringify(input.context || {}).slice(0, 3000)}
历史调试记录：${JSON.stringify(input.history || []).slice(0, 3000)}`,
        images: images.length ? images : undefined,
      },
    ],
    maxTokens: 3072,
  });

  return { ok: true, artifact_type: "debug_session", output: out };
});

// ============ Agent 15：报告生成（Report Composer）============
// 从项目真实数据生成，按电赛设计报告规范章节；数据缺失如实标注，不虚构
registerAgent("report_composer", async (input) => {
  const { requirements, solution, bom, test_results, debug_notes, team } = input;
  if (!solution) return { ok: false, output: null, message: "缺少最终方案 solution（报告必须基于已确认方案生成）" };

  const md = await llmComplete({
    system: `你是电赛设计报告撰写专家。按全国大学生电子设计竞赛设计报告规范生成 Markdown 报告，章节：
摘要（含关键词）/ 1 题意分析与设计假设 / 2 方案论证与比较 / 3 系统总体设计（含系统框图，用 mermaid 描述）/ 4 理论分析与参数计算 / 5 电路与程序设计 / 6 测试方案与测试结果 / 7 结论 / 附录（元器件清单、程序清单说明）
硬规则：
1. 所有具体数据（型号、电压、采样率、测试结果）只能来自输入的项目数据，禁止编造
2. 缺失的数据写 "【待补充：xxx】"占位，不得虚构测试数值
3. 方案论证部分必须对比输入中的候选方案并说明选择理由
4. 测试结果以表格呈现，并与需求指标（REQ）逐条对照
5. 若输入含【题意分析与设计假设】，原样纳入第 1 章 ——
   评委需要看到题面表述不明确时的判断依据，不得改写或省略
6. 语言规范、工程化，符合评审口味；篇幅控制在正文 6000 字以内`,
    messages: [
      {
        role: "user",
        content: `项目数据：
【结构化需求】${JSON.stringify(requirements || {}).slice(0, 5000)}
【最终方案】${JSON.stringify(solution).slice(0, 6000)}
【BOM】${JSON.stringify(bom || {}).slice(0, 3000)}
【测试结果】${JSON.stringify(test_results || "（暂无，请占位）").slice(0, 3000)}
【调试记录摘要】${JSON.stringify(debug_notes || []).slice(0, 2000)}
${input.design_assumptions ? `\n【题意分析与设计假设】（原样纳入第 1 章）\n${String(input.design_assumptions).slice(0, 3000)}` : ""}
【代码文件清单】${JSON.stringify(input.code_files || "（未提供，附录中省略代码清单）").slice(0, 1500)}
【队伍信息】${JSON.stringify(team || {})}`,
      },
    ],
    maxTokens: 8192,
    temperature: 0.4,
  });

  // 一致性检查：报告中出现的 MCU/关键器件必须在方案里存在
  const consistency: string[] = [];
  const solutionText = JSON.stringify(solution);
  for (const mpn of md.match(/[A-Z]{2,}[0-9]{2,}[A-Z0-9]*/g) || []) {
    if (mpn.length >= 6 && !solutionText.includes(mpn) && !JSON.stringify(bom || {}).includes(mpn)) {
      consistency.push(`报告提到 ${mpn}，但方案与 BOM 中均未找到，请核实`);
    }
  }

  return {
    ok: true,
    artifact_type: "report",
    output: { markdown: md, consistency_issues: [...new Set(consistency)].slice(0, 10) },
    human_review_required: consistency.length > 0,
  };
});

// ============ Agent 1：总控编排（Orchestrator）============
// 判断用户意图 → 生成工作流（要调哪些 Agent、什么顺序、哪里需要人工确认）
registerAgent("orchestrator", async (input, ctx) => {
  const out = await llmJson<{
    intent: string;
    reply: string;
    tasks: { agent: string; task: string; depends_on: string[] }[];
    required_approvals: string[];
  }>({
    system: `你是电赛智能体的总控编排器。可调度的 Agent：
problem_interpreter(赛题理解) topic_forecast(题目预测) module_knowledge(模块推荐)
solution_architect(方案生成) integration_checker(接口检查) bom_agent(BOM整理)
procurement_planner(备料规划) code_generator(代码生成) labsight_debug(调试) report_composer(报告)
规则：
1. 判断用户处于备赛/解题/设计/开发/调试/写报告哪个阶段
2. 生成任务列表（含依赖关系），不自己编造工程细节
3. 关键节点标注 required_approvals：候选方案必须人工确认；接口检查不过禁止代码生成；未测试不得在报告写"达到指标"
4. 项目当前阶段：${ctx.stage}；该阶段允许的操作要与状态机一致
5. reply 用中文对用户说明接下来会做什么`,
    messages: [{ role: "user", content: String(input.user_request || input.objective || "") }],
    maxTokens: 2048,
  });
  return { ok: true, output: out };
});
