import { describe, it, expect } from "vitest";
import { mapRow } from "../scripts/import-eetree.mts";

/** eetree 导出数据的字段映射。
 *  真实导出中存在两类陷阱：同年同题号有多场（初赛/决赛、7月/10月），
 *  以及题目名称里混着年份、场次、组别等元信息。 */

describe("eetree 字段映射", () => {
  it("解析年份与题号（含中文后缀）", () => {
    const r = mapRow({ "年份": "2025年", "题号": "A题", "题目名称": "能量回馈的变流器负载试验装置", "任务": "设计并制作…" } as any);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.year).toBe(2025);
    expect(r.data.code).toBe("A");
  });

  it("从标题剥离年份/场次前缀", () => {
    const r = mapRow({ "年份": "2024年", "题号": "A题", "题目名称": "2024年决赛_A题：集成运放参数测量装置", "任务": "x" } as any);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.title).toBe("集成运放参数测量装置");
    expect(r.data.stage).toBe("决赛");
  });

  it("识别月份场次（2022 年有 7 月与 10 月两场）", () => {
    const a = mapRow({ "年份": "2022年", "题号": "A题", "题目名称": "2022年_7月_A题 ：单相交流电子负载", "任务": "x" } as any);
    const b = mapRow({ "年份": "2022年", "题号": "A题", "题目名称": "2022年_10月_A题 - 无线充电可循迹电动小车", "任务": "x" } as any);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.data.stage).toBe("7月");
    expect(b.data.stage).toBe("10月");
    // 同年同题号但场次不同，必须能区分，否则导入时会互相覆盖
    expect(a.data.title).not.toBe(b.data.title);
  });

  it("从标题尾注提取组别（导出中组别字段仅 5% 有值）", () => {
    const r = mapRow({ "年份": "2024年", "题号": "B题", "题目名称": "单相功率分析仪【本科组/高职高专组】", "任务": "x" } as any);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.title).toBe("单相功率分析仪");
    expect(r.data.group).toContain("本科组");
  });

  it("题面按 任务/要求/评分标准 分节拼接，保留原文", () => {
    const r = mapRow({
      "年份": "2023年", "题号": "C题", "题目名称": "测试",
      "任务": "设计一个装置", "要求": "1. 基本要求\n（1）输出 5V", "评审标准": "基本要求 50 分",
    } as any);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rawText).toContain("一、任务");
    expect(r.data.rawText).toContain("二、要求");
    expect(r.data.rawText).toContain("三、评分标准");
    expect(r.data.rawText).toContain("（1）输出 5V");   // 原文换行与编号保留
    expect(r.data.hasScoring).toBe(true);
  });

  it("PDF 地址取数组首个 http 链接", () => {
    const r = mapRow({
      "年份": "2023年", "题号": "A题", "题目名称": "x", "任务": "y",
      "PDF 地址": ["https://www.eetree.cn/wiki/_media/nc2023a.pdf"],
    } as any);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.pdfUrl).toMatch(/^https:\/\/.*\.pdf$/);
  });

  it("空数组 PDF 地址不产生假链接", () => {
    const r = mapRow({ "年份": "2025年", "题号": "A题", "题目名称": "x", "任务": "y", "PDF 地址": [] } as any);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.pdfUrl).toBeUndefined();
  });

  it("自动建议技术方向", () => {
    const r = mapRow({ "年份": "2025年", "题号": "A题", "题目名称": "能量回馈的变流器负载试验装置", "任务": "变流器 DC-AC 逆变" } as any);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tech).toContain("power");
  });

  it("缺少必要字段时拒绝导入，不猜测", () => {
    expect(mapRow({ "年份": "无", "题号": "A题", "题目名称": "x", "任务": "y" } as any).ok).toBe(false);
    expect(mapRow({ "年份": "2025年", "题号": "A题", "题目名称": "", "任务": "y" } as any).ok).toBe(false);
    // 任务与要求都为空 → 没有题面可提取
    expect(mapRow({ "年份": "2025年", "题号": "A题", "题目名称": "x" } as any).ok).toBe(false);
  });
});
