/** 赛题分类体系。
 *  技术分类沿用电赛官方历年题目的传统划分，便于按方向检索与横向对比。 */

export const CONTEST_TYPES = ["national", "provincial", "invitational", "practice"] as const;
export type ContestType = (typeof CONTEST_TYPES)[number];

export const CONTEST_LABEL: Record<ContestType, string> = {
  national: "全国大学生电子设计竞赛（国赛）",
  provincial: "省级赛区",
  invitational: "邀请赛 / 专项赛",
  practice: "练习题 / 往届模拟",
};

/** 技术方向。一道题可属多个方向（如「电源 + 控制」）。 */
export const TECH_CATEGORIES = [
  "power", "signal_source", "rf", "amplifier", "instrument",
  "data_acquisition", "control", "mechatronic", "sensor", "communication",
] as const;
export type TechCategory = (typeof TECH_CATEGORIES)[number];

export const TECH_LABEL: Record<TechCategory, string> = {
  power: "电源类",
  signal_source: "信号源类",
  rf: "高频无线电类",
  amplifier: "放大器类",
  instrument: "仪器仪表类",
  data_acquisition: "数据采集与处理",
  control: "控制类",
  mechatronic: "机电一体化",
  sensor: "传感器应用",
  communication: "通信类",
};

/** 关键词 → 技术方向。用于导入时给出建议分类，最终仍由工程师确认。 */
const KEYWORDS: Record<TechCategory, string[]> = {
  // 注意：「电源」「供电」是题面通用词（几乎每题都写供电条件），
  // 放进关键词会把大量非电源题误判，故只保留具有判别力的词
  power: ["变换器", "变换电路", "dc-dc", "ac-dc", "dc-ac", "ac-ac", "逆变", "整流", "pfc",
          "充电", "并网", "储能", "buck", "boost", "电力滤波", "变流器", "电子负载", "稳压"],
  signal_source: ["信号发生", "波形", "dds", "函数发生", "扫频", "调制信号"],
  rf: ["无线", "射频", "天线", "收发", "调频", "调幅", "微波", "信道"],
  amplifier: ["放大器", "运放", "增益", "功放", "vga", "跨阻"],
  instrument: ["测量", "仪器", "示波", "频谱", "阻抗", "电桥", "万用表", "计数器",
               "分析仪", "测试仪", "检测装置", "测量装置"],
  data_acquisition: ["采集", "adc", "采样", "fft", "频谱分析", "数据处理"],
  control: ["控制", "pid", "伺服", "调速", "跟踪", "稳定", "平衡", "自动调节", "闭环"],
  mechatronic: ["小车", "无人机", "机器人", "云台", "机械臂", "循迹", "四旋翼", "飞行器",
                "电动车", "泊车", "绕障", "避障", "行进", "自动驾驶"],
  sensor: ["传感", "检测", "识别", "测距", "温度", "磁场", "光电"],
  communication: ["通信", "编解码", "误码", "协议", "组网", "中继"],
};

/** 从标题与题面推断技术方向（建议值，需人工确认）。
 *
 *  权重设计的依据：赛题标题几乎总是点明技术方向（「基于单目视觉的目标物测量装置」），
 *  而题面里的词高度嘈杂 —— 几乎每道题都会写供电条件，「电源」一词在
 *  视觉测量题里也能出现四五次。若标题与题面同权，会把大量题目误判为电源类。
 *  因此标题命中记 10 分，题面命中按出现次数记分但封顶 3 分，
 *  且题面单独命中（标题完全没提）必须达到阈值才纳入。 */
export function suggestTechTags(title: string, body = ""): TechCategory[] {
  // 标题里出现「电源」才算电源类信号 —— 题面里的供电条件不算
  const TITLE_ONLY_WORDS: Partial<Record<TechCategory, string[]>> = {
    power: ["电源", "供电"],
  };
  const t = String(title || "").toLowerCase();
  const b = String(body || "").toLowerCase();

  const TITLE_WEIGHT = 10;
  const BODY_CAP = 3;              // 题面得分上限，避免高频词淹没标题信号
  const BODY_ONLY_THRESHOLD = 3;   // 标题未提及时，题面需足够强的信号才纳入

  const hits: { cat: TechCategory; score: number; fromTitle: boolean }[] = [];
  for (const [cat, words] of Object.entries(KEYWORDS) as [TechCategory, string[]][]) {
    let titleScore = 0;
    let bodyScore = 0;
    // 仅在标题中才计分的词
    for (const w of TITLE_ONLY_WORDS[cat] || []) {
      if (t.includes(w)) titleScore += TITLE_WEIGHT;
    }
    for (const w of words) {
      if (t.includes(w)) titleScore += TITLE_WEIGHT;
      if (b.includes(w)) {
        // 出现次数越多信号越强，但封顶，防止「电源」这类通用词刷分
        const times = b.split(w).length - 1;
        bodyScore += Math.min(times, BODY_CAP);
      }
    }
    const total = titleScore + Math.min(bodyScore, BODY_CAP * 2);
    if (!total) continue;
    // 标题没提到的方向，题面信号必须够强
    if (!titleScore && bodyScore < BODY_ONLY_THRESHOLD) continue;
    hits.push({ cat, score: total, fromTitle: titleScore > 0 });
  }

  // 标题一旦命中任何方向，就只采信标题 —— 题面词太嘈杂，
  // 「测量装置」题面里常出现充电、供电，会带出无关的电源类标签
  const titleHits = hits.filter((h) => h.fromTitle);
  const pool = titleHits.length ? titleHits : hits;
  return pool
    .sort((x, y) => y.score - x.score)
    .slice(0, 3)
    .map((h) => h.cat);
}

export function parseTags(raw: unknown): TechCategory[] {
  if (Array.isArray(raw)) return raw.filter((t): t is TechCategory => (TECH_CATEGORIES as readonly string[]).includes(t));
  if (typeof raw === "string") {
    try { return parseTags(JSON.parse(raw)); } catch { /* 非 JSON */ }
    return raw.split(",").map((s) => s.trim()).filter((t): t is TechCategory =>
      (TECH_CATEGORIES as readonly string[]).includes(t));
  }
  return [];
}
