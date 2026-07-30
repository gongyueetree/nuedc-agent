/** 需求指标的规范化与校验。
 *
 *  学生测试发现的问题：需求显示成 `1Hz~1MHzHz`、`≤1%%`、`≤1°°` ——
 *  模型把单位写进了 target（"1Hz~1MHz"），显示层又拼了一次 unit。
 *  这类错误会一路传播到方案、BOM、代码、测试评分与报告，
 *  因此需要在入库前规范化，并在确认前作为阻断项校验。
 */

export type Severity = "error" | "warning";

export interface RequirementIssue {
  field: "target" | "unit" | "tolerance" | "description" | "type";
  severity: Severity;
  message: string;
  /** 建议的修正值；null 表示只能人工判断 */
  suggestion?: string | null;
}

/** 常见单位，用于识别 target 里已含单位的情况 */
const UNITS = [
  "Hz", "kHz", "MHz", "GHz",
  "V", "mV", "kV", "Vpp", "mVpp", "Vrms", "mVrms",
  "A", "mA", "uA", "μA",
  "W", "mW", "kW", "VA",
  "Ω", "ohm", "kΩ", "MΩ",
  "F", "uF", "μF", "nF", "pF",
  "H", "mH", "uH", "μH",
  "s", "ms", "us", "μs", "ns",
  "dB", "dBm", "dBc",
  "%", "°", "度", "℃", "°C",
  "m", "cm", "mm", "km",
  "g", "kg", "bit", "bps", "kbps", "Mbps",
];

/** 按长度倒序，先匹配 mVpp 再匹配 V，避免误截 */
const UNITS_SORTED = [...UNITS].sort((a, b) => b.length - a.length);

/** 从 target 文本尾部拆出单位。"1MHz" → { value: "1", unit: "MHz" } */
function splitTrailingUnit(raw: string): { value: string; unit: string | null } {
  const t = raw.trim();
  for (const u of UNITS_SORTED) {
    if (t.toLowerCase().endsWith(u.toLowerCase())) {
      return { value: t.slice(0, t.length - u.length).trim(), unit: u };
    }
  }
  return { value: t, unit: null };
}

export interface NormalizedTarget {
  target: string | null;
  unit: string | null;
  tolerance: string | null;
  issues: RequirementIssue[];
}

/** 规范化单条需求的指标字段。
 *  规则：
 *  - target 尾部已含单位时，把单位移到 unit，target 只留数值/范围
 *  - target 与 unit 单位不一致时报 error（可能是解析串行）
 *  - tolerance 里重复的比较符与百分号一并清理
 */
export function normalizeTarget(input: {
  target?: unknown; unit?: unknown; tolerance?: unknown;
}): NormalizedTarget {
  const issues: RequirementIssue[] = [];
  let target = input.target == null || input.target === "" ? null : String(input.target).trim();
  let unit = input.unit == null || input.unit === "" ? null : String(input.unit).trim();
  let tolerance = input.tolerance == null || input.tolerance === "" ? null : String(input.tolerance).trim();

  const isRange = !!target && /[~～]|(?<=\d)\s*-\s*(?=\d)/.test(target);
  const targetHasUnit = !!target && UNITS_SORTED.some((u) =>
    new RegExp(`\\d\\s*${u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(target!));

  if (target && targetHasUnit) {
    if (isRange) {
      // 范围值两端各带单位（10mVpp~10Vpp、1Hz~1MHz）是完整表述，
      // 保持原样，清空 unit 以免显示层拼出 "1Hz~1MHzHz"
      if (unit) {
        issues.push({
          field: "unit", severity: "warning",
          message: `范围值已含单位，已清空重复的 unit「${unit}」`, suggestion: "",
        });
        unit = null;
      }
    } else {
      // 单值含单位（"100mA"）：拆出来放进 unit，target 只留数值
      const { value, unit: embedded } = splitTrailingUnit(target);
      if (embedded) {
        if (!unit || unit.toLowerCase() === embedded.toLowerCase()) {
          unit = embedded;
          target = value || null;
        } else {
          // 两者都有且不同：以 target 内的为准（更贴近原文），并记录
          issues.push({
            field: "unit", severity: "warning",
            message: `指标值含单位「${embedded}」，与 unit 字段「${unit}」不一致，已采用前者`,
            suggestion: embedded,
          });
          unit = embedded;
          target = value || null;
        }
      }
    }
  }

  // tolerance 里的重复符号：「≤1%%」「≤≤1%」
  if (tolerance) {
    const before = tolerance;
    tolerance = tolerance
      .replace(/%{2,}/g, "%")
      .replace(/°{2,}/g, "°")
      .replace(/([≤≥<>=]){2,}/g, "$1")
      .trim();
    if (tolerance !== before) {
      issues.push({
        field: "tolerance", severity: "warning",
        message: `误差表述含重复符号，已规范化为「${tolerance}」`, suggestion: tolerance,
      });
    }
  }

  // 误差已含单位时，避免与 unit 重复显示
  if (tolerance && unit && new RegExp(`${unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i").test(tolerance)) {
    // tolerance 自带单位是正常的（"≤1%"），不做处理，仅在 target 为空时提示
  }

  if (!target && unit) {
    issues.push({
      field: "target", severity: "warning",
      message: `填了单位「${unit}」但没有指标值`, suggestion: null,
    });
  }

  return { target, unit, tolerance, issues };
}

/** 校验单条需求，返回所有问题。error 级别应阻断确认。 */
export function validateRequirement(r: {
  requirement_no?: unknown; description?: unknown; type?: unknown;
  target?: unknown; unit?: unknown; tolerance?: unknown;
  source_quote?: unknown; source_page?: unknown;
}): RequirementIssue[] {
  const issues: RequirementIssue[] = [];

  const desc = String(r.description || "").trim();
  if (!desc) {
    issues.push({ field: "description", severity: "error", message: "需求描述为空" });
  } else if (desc.length < 6) {
    issues.push({ field: "description", severity: "warning", message: "需求描述过短，可能提取不完整" });
  }

  // 描述里出现重复单位（显示层拼接的产物被回写时也要能抓到）
  for (const u of UNITS_SORTED) {
    const dup = new RegExp(`${u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*${u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    if (dup.test(desc)) {
      issues.push({
        field: "description", severity: "error",
        message: `描述中出现重复单位「${u}${u}」，多为解析错误`,
      });
      break;
    }
  }
  if (/%%|°°|≤≤|≥≥/.test(desc)) {
    issues.push({ field: "description", severity: "error", message: "描述中出现重复的单位或比较符" });
  }

  issues.push(...normalizeTarget(r).issues);

  const type = String(r.type || "");
  if (!["basic", "advanced", "uncertain", "mandatory", "optional", ""].includes(type)) {
    issues.push({ field: "type", severity: "warning", message: `未知的需求类型「${type}」` });
  }
  if (type === "uncertain") {
    issues.push({
      field: "type", severity: "warning",
      message: "类型待定：分不清基本要求还是发挥部分，会影响评分权重",
    });
  }

  // 发布清单要求可溯源
  if (!String(r.source_quote || "").trim() && r.source_page == null) {
    issues.push({ field: "description", severity: "warning", message: "缺少原文引用或页码，无法溯源核对" });
  }

  return issues;
}

/** 批量校验，给出可用于阻断的汇总 */
export function validateRequirements(list: any[]): {
  byIndex: Map<number, RequirementIssue[]>;
  errorCount: number;
  warningCount: number;
  blockingIndexes: number[];
} {
  const byIndex = new Map<number, RequirementIssue[]>();
  let errorCount = 0;
  let warningCount = 0;
  const blockingIndexes: number[] = [];

  list.forEach((r, i) => {
    const issues = validateRequirement(r);
    if (issues.length) byIndex.set(i, issues);
    const errs = issues.filter((x) => x.severity === "error").length;
    errorCount += errs;
    warningCount += issues.length - errs;
    if (errs) blockingIndexes.push(i);
  });

  return { byIndex, errorCount, warningCount, blockingIndexes };
}
