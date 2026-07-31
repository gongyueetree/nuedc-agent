/** 测试指标的类型化录入。
 *
 *  学生测试报告（2026-07-28）P1-2：测试评分页对所有需求用同一种录入方式，
 *  但"输出电压 32V±0.25V"和"具备过流保护功能"的验证方式完全不同 ——
 *  前者要填实测值并比对容差，后者只需判定通过/不通过并附证据。
 *  混在一起会让学生不知道该填什么，也让判定无从自动化。
 */

export const METRIC_KINDS = [
  "single_point", "range", "functional", "timing", "safety", "bonus",
] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];

export interface MetricKindSpec {
  label: string;
  /** 录入什么 */
  inputs: { key: string; label: string; hint?: string; type: "number" | "text" | "bool" | "file" }[];
  /** 如何判定 */
  judge: string;
  /** 常见坑，直接显示给学生 */
  tip?: string;
}

export const METRIC_SPECS: Record<MetricKind, MetricKindSpec> = {
  single_point: {
    label: "单点指标",
    inputs: [
      { key: "measured", label: "实测值", type: "number", hint: "填数值即可，单位见指标" },
      { key: "condition", label: "测试条件", type: "text", hint: "如：满载、25℃、输入 220V" },
      { key: "instrument", label: "所用仪器", type: "text", hint: "如：Fluke 15B+" },
    ],
    judge: "实测值落在 目标值±容差 内判通过",
    tip: "同一指标建议测三次取最差值 —— 评委现场复测时不会挑最好的那次",
  },
  range: {
    label: "范围指标",
    inputs: [
      { key: "min_measured", label: "下限实测", type: "number" },
      { key: "max_measured", label: "上限实测", type: "number" },
      { key: "step_note", label: "扫描说明", type: "text", hint: "如：10 点均匀扫描，最差点 1.2%" },
      { key: "worst_error", label: "最差误差", type: "number", hint: "整个范围内误差最大的那一点" },
    ],
    judge: "实测范围覆盖要求范围，且最差点误差仍在容差内",
    tip: "只测两个端点容易漏掉中间的凹陷，务必在范围内多取几点",
  },
  functional: {
    label: "功能项",
    inputs: [
      { key: "verdict", label: "是否实现", type: "bool" },
      { key: "evidence", label: "验证方式", type: "text", hint: "如何证明做到了：操作步骤 + 观察到的现象" },
      { key: "media", label: "照片/录屏", type: "file", hint: "现场演示的凭证" },
    ],
    judge: "有可复现的验证过程即判通过",
    tip: "写清楚操作步骤，评委会照着复现一遍",
  },
  timing: {
    label: "时序 / 响应",
    inputs: [
      { key: "measured", label: "实测时间", type: "number", hint: "单位见指标，如 ms / s" },
      { key: "method", label: "测量方法", type: "text", hint: "如：示波器双通道触发，测上升沿到稳定" },
      { key: "samples", label: "测试次数", type: "number", hint: "建议不少于 5 次" },
    ],
    judge: "实测时间不超过要求上限（取最差一次）",
    tip: "响应时间受负载影响大，注明测试时的负载条件",
  },
  safety: {
    label: "保护 / 安全",
    inputs: [
      { key: "verdict", label: "保护是否动作", type: "bool" },
      { key: "trigger_value", label: "动作阈值", type: "number", hint: "实际在什么值触发" },
      { key: "recovery", label: "恢复情况", type: "text", hint: "故障排除后能否自动或手动恢复" },
      { key: "evidence", label: "验证记录", type: "text" },
    ],
    judge: "保护动作可靠触发，且不损坏设备",
    tip: "务必在限流电源或有保护的条件下验证，别把板子烧了",
  },
  bonus: {
    label: "发挥部分",
    inputs: [
      { key: "verdict", label: "是否完成", type: "bool" },
      { key: "measured", label: "达到的指标", type: "text", hint: "做到什么程度" },
      { key: "evidence", label: "证据", type: "text" },
    ],
    judge: "按完成度计分，部分完成也可得分",
    tip: "发挥部分即使没做完，做到哪一步也要如实记录 —— 有分可拿",
  },
};

/** 按需求内容推断指标类型。返回建议值，学生可改。 */
export function inferMetricKind(r: {
  description?: unknown; type?: unknown; priority?: unknown;
  target?: unknown; unit?: unknown; verification_method?: unknown;
}): MetricKind {
  const desc = String(r.description || "");
  const target = String(r.target || "");
  const isBonus = String(r.type) === "advanced" || String(r.priority) === "bonus";

  if (/保护|过流|过压|过温|短路|急停|安全/.test(desc)) return "safety";
  if (/响应|建立|恢复|启动时间|延时|时间不(大于|超过)|上升沿|下降沿/.test(desc)) return "timing";
  // 范围：目标值本身是区间，或描述里有"范围""可调"
  if (/[~～]|至少.*到|范围|可调|扫描/.test(target + desc) && r.target) return "range";
  if (r.target != null && String(r.target).trim() !== "") {
    return isBonus ? "bonus" : "single_point";
  }
  if (isBonus) return "bonus";
  return "functional";
}

/** 判定一条记录是否通过。返回 null 表示数据不足以判定。 */
export function judgeRecord(
  kind: MetricKind,
  req: { target?: unknown; unit?: unknown; tolerance?: unknown },
  rec: Record<string, unknown>,
): { pass: boolean | null; reason: string } {
  const num = (v: unknown) => {
    // 空字符串不能当成 0 —— 未填写与实测为零是两回事
    const raw = String(v ?? "").trim();
    if (!raw) return null;
    const cleaned = raw.replace(/[^\d.+-]/g, "");
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  };

  // 容差解析："±0.25"、"≤5%"、"±1%"
  const parseTolerance = (t: unknown, base: number | null): number | null => {
    const s = String(t ?? "").trim();
    if (!s) return null;
    const pct = s.match(/([\d.]+)\s*%/);
    if (pct && base != null) return Math.abs(base) * Number(pct[1]) / 100;
    const abs = s.match(/([\d.]+)/);
    return abs ? Number(abs[1]) : null;
  };

  if (kind === "functional" || kind === "safety" || kind === "bonus") {
    const v = rec.verdict;
    if (v === undefined || v === null || v === "") return { pass: null, reason: "未判定" };
    const pass = v === true || v === "pass" || v === "通过";
    if (pass && !String(rec.evidence || "").trim()) {
      return { pass: null, reason: "判为通过但缺少验证记录，评委会要求复现" };
    }
    return { pass, reason: pass ? "已验证" : "未实现或未通过" };
  }

  const targetNum = num(req.target);
  if (kind === "single_point" || kind === "timing") {
    const m = num(rec.measured);
    if (m == null) return { pass: null, reason: "未填实测值" };
    if (targetNum == null) return { pass: null, reason: "需求未给出目标值，需人工判定" };
    const tol = parseTolerance(req.tolerance, targetNum);
    if (kind === "timing") {
      // 时序类通常是"不超过"，取上限判定
      const limit = tol != null ? targetNum + tol : targetNum;
      return { pass: m <= limit, reason: m <= limit ? `${m} ≤ ${limit}` : `${m} 超过上限 ${limit}` };
    }
    if (tol == null) {
      return { pass: null, reason: "需求未给出容差，需人工判定" };
    }
    const ok = Math.abs(m - targetNum) <= tol;
    return { pass: ok, reason: ok ? `偏差 ${Math.abs(m - targetNum).toFixed(3)} 在 ±${tol} 内` : `偏差 ${Math.abs(m - targetNum).toFixed(3)} 超出 ±${tol}` };
  }

  if (kind === "range") {
    const lo = num(rec.min_measured);
    const hi = num(rec.max_measured);
    if (lo == null || hi == null) return { pass: null, reason: "未填范围两端实测值" };
    const worst = num(rec.worst_error);
    const tol = parseTolerance(req.tolerance, targetNum ?? hi);
    if (tol != null && worst != null && worst > tol) {
      return { pass: false, reason: `最差点误差 ${worst} 超出容差 ${tol}` };
    }
    if (worst == null) {
      // 只测两个端点无法说明范围内处处达标，这是最常见的失分点
      return { pass: null, reason: "未填最差点误差 —— 仅测端点无法证明范围内始终达标" };
    }
    return { pass: true, reason: `覆盖 ${lo} ~ ${hi}，最差误差 ${worst}` };
  }

  return { pass: null, reason: "未知指标类型" };
}
