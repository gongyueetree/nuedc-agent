import { registerAgent, currentAgentContext } from "./base";
import { llmJson } from "../llm";
import { moduleInputSchema } from "../module-schema";

/** 从工程文件附件自动生成模块信息。
 *
 *  诚实原则（与仓库既有的 BOM 低置信度、POWER_DATA_MISSING 口径一致）：
 *  - 不确定的字段留空并写进 missing_fields，绝不猜数值
 *  - 接口电平、电流等关键参数一律标 evidence_level "E0"（来源未验证）
 *  - 产物强制 DRAFT，必须人工确认后才能启用 */

const IMPORTABLE_TEXT = /^(text\/|application\/json|application\/csv)/i;
const IMPORTABLE_DOC = /^(application\/pdf|image\/)/i;
/** EDA 二进制工程文件：不假装能解析 */
const EDA_BINARY = /\.(sch|kicad_sch|kicad_pcb|schdoc|pcbdoc|prjpcb|brd|epro)$/i;

const SYSTEM = `你从电子工程文件中提取模块信息，产出结构化的模块档案。

【诚实原则 · 最重要】
1. 只提取文件里明确写出的信息。任何需要猜测的字段一律留空，并把字段名写进 missing_fields
2. 接口电平、工作电流、电压范围这类关键参数，若文件未明确标注，绝不能凭型号"推测"
3. 所有从文件提取的参数，evidence_level 一律填 "E0"（来源未经实验室验证）
4. confidence 如实反映把握程度：型号与接口都明确写出才给 0.8 以上；
   只能看出大致功能给 0.3~0.5；文件信息不足以生成模块时给 0.1 并在 notes 说明

【提取要点】
- id：用小写字母数字与连字符，形如 category-chip-variant（如 sensor-bmp280-i2c）
- category：从固定分类里选最贴近的
- interfaces：每个接口写 name / interface_type / voltage_level / five_v_tolerant / pins
- power：input_voltage_range [最小,最大] / typical_current_ma / peak_current_ma
- usage_notes：文件里提到的注意事项
- known_issues：文件里提到的缺陷、限制、勘误

只输出 JSON。`;

registerAgent("module_ingestion", async (input: any) => {
  const files: any[] = Array.isArray(input?.files) ? input.files : [];
  if (!files.length) {
    return { ok: false, output: null, message: "没有可导入的文件" };
  }

  // EDA 二进制工程文件：明确告知不支持，而不是产出臆造的结果
  const eda = files.filter((f) => EDA_BINARY.test(String(f.name || "")));
  if (eda.length === files.length) {
    return {
      ok: false, output: null,
      message: `暂不支持直接解析 EDA 工程文件（${eda.map((f) => f.name).join("、")}）。` +
               `请改为上传器件手册 PDF、原理图截图或规格说明；` +
               `工程文件的确定性解析将在后续版本接入。`,
    };
  }

  const usable = files.filter((f) => !EDA_BINARY.test(String(f.name || "")));
  const docFile = usable.find((f) => IMPORTABLE_DOC.test(String(f.mime || "")));
  const textFiles = usable.filter((f) => IMPORTABLE_TEXT.test(String(f.mime || "")));

  const textPayload = textFiles
    .map((f) => `--- ${f.name} ---\n${Buffer.from(String(f.data_base64 || ""), "base64").toString("utf8").slice(0, 8000)}`)
    .join("\n\n");

  const hint = input?.hint ? `\n\n用户补充说明：${input.hint}` : "";
  const userMsg = [
    docFile ? `请从附件（${docFile.name}）中提取模块信息。` : "请从以下文本中提取模块信息。",
    textPayload ? `\n${textPayload}` : "",
    hint,
  ].join("");

  let out: any;
  try {
    out = await llmJson<any>({
      system: SYSTEM,
      messages: [{ role: "user", content: userMsg }],
      maxTokens: 3000,
      taskType: "MODULE_INGEST",
      ...(docFile ? { pdfBase64: docFile.mime === "application/pdf" ? docFile.data_base64 : undefined,
                      imageBase64: String(docFile.mime).startsWith("image/") ? docFile.data_base64 : undefined,
                      imageMime: docFile.mime } : {}),
    } as any);
  } catch (e: any) {
    return { ok: false, output: null, message: `解析失败：${String(e?.message || e).slice(0, 200)}` };
  }

  const raw = out?.module ?? out;
  const ctx = currentAgentContext();

  // 归属与状态由服务端强制，模型输出不作数
  const candidate = {
    ...raw,
    certification_status: "DRAFT",
    scope: ctx.org ? "ORGANIZATION" : "PERSONAL",
    owner_ref: ctx.owner ?? null,
    org_ref: ctx.org ?? null,
    // 所有导入参数标记为未验证证据
    evidence_records: (raw?.evidence_records || []).map((e: any) => ({ ...e, evidence_level: "E0" })),
    source_snapshot: { source: "ingest", captured_at: new Date().toISOString() },
  };

  const parsed = moduleInputSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false, output: null,
      message: "提取结果不完整，无法生成合法模块档案",
      issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }

  const missing: string[] = Array.isArray(out?.missing_fields) ? out.missing_fields : [];
  const confidence = typeof out?.confidence === "number" ? out.confidence : 0.3;

  return {
    ok: true,
    artifact_type: "module_draft",
    output: {
      module: parsed.data,
      confidence,
      missing_fields: missing,
      notes: Array.isArray(out?.notes) ? out.notes : [],
      skipped_files: eda.map((f) => f.name),
    },
    human_review_required: true,
    message: confidence < 0.5
      ? `提取置信度较低（${(confidence * 100).toFixed(0)}%），请逐项核对后再启用`
      : `已生成草稿，${missing.length ? `${missing.length} 个字段需补充：${missing.slice(0, 4).join("、")}` : "请人工确认后启用"}`,
  };
});
