"use client";
import { useMemo, useState } from "react";
import { emitToEzplm } from "./api";
import { StaleBanner } from "./pages-build";
import { inferMetricKind, judgeRecord, METRIC_SPECS, METRIC_KINDS, type MetricKind } from "../lib/test-metrics";

/* ============ BOM 工作台 ============ */
const PROC_STATUS = ["待采购", "已下单", "已到货", "库存借用", "自制"] as const;

export function BomPage({ ctx }: { ctx: any }) {
  const items: any[] = ctx.bom?.items || [];
  const [genErr, setGenErr] = useState("");
  const [genMsg, setGenMsg] = useState("");
  async function genFromSolution() {
    setGenErr(""); setGenMsg("正在解析方案并整理物料清单…");
    const r = await ctx.runBomFromSolution();
    setGenMsg("");
    if (!r) { setGenErr("调用未返回结果（前端异常，请刷新页面重试）"); return; }
    if (!r.ok) { setGenErr(r.message || "生成失败（原因未知）"); return; }
    const n = r.output?.items?.length ?? 0;
    if (!n) setGenErr("模型返回了空清单 —— 可能方案功能块信息不足，请重试或改用「粘贴文本/CSV 整理」");
  }
  // 本地工作台状态：库存数 / 采购状态（叠加在 BOM 之上，导出时合并）
  const [local, setLocal] = useState<Record<string, { stock: number; status: string }>>({});
  const [group, setGroup] = useState<string>("all");
  const L = (id: string) => local[id] || { stock: 0, status: "待采购" };
  const setL = (id: string, patch: any) => setLocal((s) => ({ ...s, [id]: { ...L(id), ...patch } }));

  const groups = [
    { key: "all", label: "全部" },
    { key: "module", label: "功能模块" },
    { key: "component", label: "裸器件" },
    { key: "shortage", label: "⚠ 缺料" },
    { key: "review", label: "需人工确认" },
  ];
  const shown = useMemo(() => items.filter((it) => {
    const l = L(it.line_id);
    const short = l.stock < it.quantity && l.status !== "已到货";
    if (group === "module") return it.source_type === "module";
    if (group === "component") return it.source_type === "component";
    if (group === "shortage") return short;
    if (group === "review") return it.needs_review;
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [items, group, local]);

  const shortage = items.filter((it) => L(it.line_id).stock < it.quantity && L(it.line_id).status !== "已到货").length;

  function exportCsv() {
    const head = ["行号","名称","MPN","厂商","类别","封装","数量","库存","缺口","采购状态","替代料","单价","置信度","需确认"];
    const rows = items.map((it) => {
      const l = L(it.line_id);
      return [it.line_id, it.name, it.mpn, it.manufacturer || "", it.category, it.package || "",
        it.quantity, l.stock, Math.max(0, it.quantity - l.stock), l.status,
        (it.substitutes || []).join(" / "), it.unit_price ?? "", it.confidence, it.needs_review ? "是" : ""];
    });
    const csv = "\ufeff" + [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `BOM-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }
  function syncEzplm() {
    emitToEzplm("bom_ready", { items: items.map((it) => ({ ...it, ...L(it.line_id) })) });
  }

  if (!items.length) return (
    <div className="card">
      <h3>物料清单还是空的</h3>
      <p className="hint">
        {ctx.chosenSolution
          ? `已确认方案「${ctx.chosenSolution.name}」，点下方按钮即可按方案中的功能块生成物料清单（含备料数量规则与替代料）。`
          : "尚未确认主方案 —— 建议先到「方案生成」页采用一套方案，这样 BOM 能直接按方案功能块生成。"}
      </p>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn sm" disabled={ctx.busy || !ctx.chosenSolution} onClick={genFromSolution}>从已确认方案生成</button>
        <BomPaste ctx={ctx} />
      </div>
      {!ctx.chosenSolution && <p className="hint" style={{ marginTop: 8 }}>（从方案生成需要先在「方案生成」页确认一套方案）</p>}
      {genMsg && <p className="hint" style={{ marginTop: 8 }}><span className="spinner" /> {genMsg}</p>}
      {genErr && <div className="issue blocker" style={{ marginTop: 10, display: "block" }}>生成失败：{genErr}</div>}
      {!ctx.chosenSolution && (
        <p className="hint" style={{ marginTop: 8 }}>
          ⚠ 当前没有已确认的主方案，「从已确认方案生成」按钮不可用。请到「方案生成」页点某套方案的「采用为主方案」。
        </p>
      )}
    </div>
  );

  return (
    <>
      <StaleBanner ctx={ctx} types={["bom", "procurement_plan"]} label="物料清单" exists={!!ctx.bom?.items?.length} />
      {ctx.bom?.partial_output && (
        <div className="issue blocker" style={{ display: "block", marginBottom: 12 }}>
          ⚠ <b>物料清单可能不完整</b>：本次输出曾被截断修复，末尾物料可能缺失。请对照方案功能块核对后再采购。
        </div>
      )}
      {(ctx.bom?.dropped_rows > 0 || ctx.bom?.quantity_unknown_rows > 0) && (
        <div className="issue warning" style={{ display: "block", marginBottom: 12 }}>
          {ctx.bom.model_returned > 0 && <>模型返回 {ctx.bom.model_returned} 项，有效 {items.length} 项</>}
          {ctx.bom.dropped_rows > 0 && <>，已剔除 {ctx.bom.dropped_rows} 项结构异常</>}
          {ctx.bom.quantity_unknown_rows > 0 && <>；{ctx.bom.quantity_unknown_rows} 项数量无法解析（暂按 1 计并标记需确认）</>}
        </div>
      )}
      <div className="statsbar" style={{ marginBottom: 14 }}>
        <span><b>{items.length}</b> 行物料</span>
        <span><b style={{ color: shortage ? "var(--red)" : "var(--ok)" }}>{shortage}</b> 行缺料</span>
        <span><b>{items.filter((i) => i.needs_review).length}</b> 行需人工确认</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn ghost sm" disabled={ctx.busy} onClick={genFromSolution}>重新生成</button>
          <button className="btn ghost sm" onClick={exportCsv}>⬇ 导出 Excel (CSV)</button>
          <button className="btn sm" onClick={syncEzplm}>同步到 ezPLM</button>
        </span>
      </div>
      <div className="filterbar">
        {groups.map((g) => (
          <button key={g.key} className={"fchip" + (group === g.key ? " on" : "")} onClick={() => setGroup(g.key)}>{g.label}</button>
        ))}
        <span className="hint" style={{ marginLeft: "auto" }}>库存与采购状态在本页维护，导出/同步时合并</span>
      </div>
      <div className="card" style={{ padding: 8 }}>
        <table className="data">
          <thead><tr>
            <th>行号</th><th>名称 / MPN</th><th>数量</th><th>库存</th><th>缺口</th><th>采购状态</th><th>替代料</th><th></th>
          </tr></thead>
          <tbody>
            {shown.map((it) => {
              const l = L(it.line_id);
              const gap = Math.max(0, it.quantity - l.stock);
              return (
                <tr key={it.line_id} style={it.needs_review ? { background: "#fffbeb" } : undefined}>
                  <td className="hint">{it.line_id}</td>
                  <td><b>{it.name}</b><br /><span className="hint">{it.mpn}{it.manufacturer ? ` · ${it.manufacturer}` : ""}{it.package ? ` · ${it.package}` : ""}</span></td>
                  <td><b>{it.quantity}</b>{it.quantity_unknown && <><br /><span className="chip gold" style={{ fontSize: 10 }}>数量待定</span></>}</td>
                  <td><input type="number" min={0} value={l.stock} style={{ width: 58, padding: 4, border: "1px solid var(--line)", borderRadius: 6 }}
                    onChange={(e) => setL(it.line_id, { stock: Number(e.target.value) })} /></td>
                  <td>{gap > 0 && l.status !== "已到货" ? <span className="chip red">缺 {gap}</span> : <span className="chip green">✓</span>}</td>
                  <td>
                    <select value={l.status} onChange={(e) => setL(it.line_id, { status: e.target.value })}
                      style={{ padding: 4, border: "1px solid var(--line)", borderRadius: 6 }}>
                      {PROC_STATUS.map((s) => <option key={s}>{s}</option>)}
                    </select>
                  </td>
                  <td className="hint">{(it.substitutes || []).join("、") || "—"}</td>
                  <td>{it.needs_review && <span className="chip gold">置信度 {Math.round(it.confidence * 100)}%</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {ctx.bom?.unresolved_items?.length > 0 && (
        <div className="issue warning" style={{ marginTop: 10 }}>无法解析的行（原文保留）：{ctx.bom.unresolved_items.join("；")}</div>
      )}
    </>
  );
}

function BomPaste({ ctx }: { ctx: any }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  if (!open) return <button className="btn ghost sm" onClick={() => setOpen(true)}>粘贴文本/CSV 整理</button>;
  return (
    <div className="modal-mask" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>粘贴物料文本</h3>
        <textarea className="area" rows={8} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={"每行一项，随意格式即可：\nMSPM0G3507 开发板 2块\ntb6612 电机驱动*1\n10k 0603 电阻 x20"} />
        <div style={{ textAlign: "right", marginTop: 10, display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn ghost sm" onClick={() => setOpen(false)}>取消</button>
          <button className="btn sm" disabled={ctx.busy || !text.trim()} onClick={async () => { await ctx.runBomFromText(text); setOpen(false); }}>整理</button>
        </div>
      </div>
    </div>
  );
}

/* ============ 测试与评分工作台 ============ */
export function TestingPage({ ctx }: { ctx: any }) {
  const reqs: any[] = (ctx.requirements?.requirements || []).filter((r: any) => r.status !== "REJECTED");
  const plan: any[] = ctx.testPlan?.test_cases || [];
  const planOf = (id: string) => plan.find((t) => t.requirement_id === id);
  const [records, setRecords] = useState<Record<string, any>>(
    Object.fromEntries((ctx.testRecords || []).map((r: any) => [r.requirement_id, r]))
  );
  const R = (id: string) => records[id] || { requirement_id: id };
  const setR = (id: string, patch: any) => setRecords((s) => ({ ...s, [id]: { ...R(id), ...patch } }));
  const verdictOf = (id: string) => ctx.testResult?.verdicts?.find((v: any) => v.requirement_id === id);
  const sum = ctx.testResult?.summary;

  if (!reqs.length) return (
    <div className="card"><h3>测试评分需要需求清单</h3>
      <p className="hint">请先在「方案生成」页解析赛题并逐条确认需求 —— 每条需求就是一个测试项。</p></div>
  );

  return (
    <>
      <StaleBanner ctx={ctx} types={["test_plan", "score", "test_report"]} label="测试计划与得分" exists={!!(ctx.testPlan || ctx.testResult)} />
      {sum && (
        <div className="statsbar" style={{ marginBottom: 14 }}>
          <span className={"chip " + (sum.score_basis === "official" ? "green" : "gold")}>{sum.score_basis === "official" ? `官方分值 · 总分 ${sum.official_total}` : "估算口径 60+40"}</span>
          <span>基本要求 <b style={{ color: sum.blockers.length ? "var(--red)" : "var(--ok)" }}>{sum.mandatory_passed}/{sum.mandatory_total}</b></span>
          <span>发挥要求 <b>{sum.bonus_passed}/{sum.bonus_total}</b></span>
          <span>预计得分 <b>{sum.score_low} ~ {sum.score_high}</b></span>
          <span>未测 <b>{sum.untested}</b></span>
          {sum.blockers.length > 0 && <span className="chip red">阻断 {sum.blockers.length}</span>}
        </div>
      )}
      {sum?.next_best_actions?.length > 0 && (
        <div className="issue info" style={{ marginBottom: 12, display: "block" }}>
          🎯 收益最高的下一步：{sum.next_best_actions[0]}
        </div>
      )}

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <b>测试计划</b>
          <span className="hint">仪器 / 测点 / 步骤 / 判据由测试 Agent 生成；判定与得分为纯规则计算，不经过大模型。</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost sm" disabled={ctx.busy} onClick={ctx.runTestPlan}>{plan.length ? "重新生成计划" : "生成测试计划"}</button>
          <button className="btn sm" disabled={ctx.busy}
            onClick={() => {
              // 学生测试反馈：空数据点击后没有任何反馈
              const filled = Object.values(records).filter((r: any) =>
                (r?.measured != null && String(r.measured).trim() !== "") || r?.verdict);
              if (!filled.length) {
                alert("还没有录入任何测试数据。\n\n请先在上方逐条填写实测值或点选通过/不通过，再计算得分。");
                return;
              }
              const total = Object.keys(records).length;
              if (filled.length < total && !confirm(
                `只录入了 ${filled.length}/${total} 项，未录入的会按「待补充」处理、不计入得分。\n\n继续计算？`
              )) return;
              ctx.runScore(Object.values(records));
            }}>计算判定与得分</button>
        </div>
      </div>

      {reqs.map((r: any) => {
        const p = planOf(r.id);
        const v = verdictOf(r.id);
        const rec = R(r.id);
        return (
          <div key={r.id} className="card" style={{ marginBottom: 10, borderLeft: `3px solid ${v?.passed === true ? "var(--ok)" : v?.passed === false ? "var(--red)" : "var(--line)"}` }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <span className="rid" style={{ fontFamily: "var(--mono)", fontWeight: 700, color: "var(--blue-deep)" }}>{r.id}</span>
              <b>{r.description}</b>
              {r.priority === "mandatory" ? <span className="chip red">基本</span> : <span className="chip violet">发挥</span>}
              {r.target != null && <span className="chip">指标 {r.target}{r.unit || ""}{r.tolerance ? ` ${r.tolerance}` : ""}</span>}
              <span style={{ flex: 1 }} />
              {v?.passed === true && <span className="chip green">✓ 通过</span>}
              {v?.passed === false && <span className="chip red">✗ 未通过</span>}
              {v && v.passed === null && <span className="chip">未测</span>}
            </div>
            {p && (
              <p className="hint" style={{ margin: "6px 0" }}>
                🔧 {p.instrument} · 测点：{(p.measure_points || []).join("、")} · 判据：{p.threshold}
                {p.pitfalls && <><br />⚠ {p.pitfalls}</>}
              </p>
            )}
            {p?.steps?.length > 0 && (
              <ol className="hint" style={{ margin: "4px 0 8px 18px" }}>
                {p.steps.map((s: string, i: number) => <li key={i}>{s}</li>)}
              </ol>
            )}
            {/* 按指标类型给出对应的录入项 —— 学生测试指出所有需求
                用同一种方式录入，不知道该填什么（P1-2） */}
            {(() => {
              const kind = rec.metric_kind || inferMetricKind(r);
              const spec = METRIC_SPECS[kind as MetricKind];
              const judged = judgeRecord(kind as MetricKind, r, rec);
              return (
                <>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
                    <select value={kind} onChange={(e) => setR(r.id, { metric_kind: e.target.value })}
                      style={{ padding: "4px 8px", border: "1px solid var(--line)", borderRadius: 6, fontSize: 12 }}>
                      {METRIC_KINDS.map((k) => (
                        <option key={k} value={k}>{METRIC_SPECS[k].label}</option>
                      ))}
                    </select>
                    <span className="hint">判据：{spec.judge}</span>
                  </div>
                  {spec.tip && <p className="hint" style={{ margin: "0 0 6px", color: "var(--amber, #b45309)" }}>💡 {spec.tip}</p>}

                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    {spec.inputs.map((f) => (
                      f.type === "bool" ? (
                        <span key={f.key} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                          <span className="hint">{f.label}：</span>
                          <button className={"btn sm" + (rec[f.key] === true ? " ok" : " ghost")}
                            onClick={() => setR(r.id, { [f.key]: rec[f.key] === true ? null : true })}>是</button>
                          <button className={"btn ghost sm" + (rec[f.key] === false ? " danger" : "")}
                            onClick={() => setR(r.id, { [f.key]: rec[f.key] === false ? null : false })}>否</button>
                        </span>
                      ) : (
                        <label key={f.key} className="hint" title={f.hint || ""}>
                          {f.label}
                          <input value={String(rec[f.key] ?? "")} placeholder={f.hint || ""}
                            style={{ width: f.type === "number" ? 110 : 190, marginLeft: 6, padding: 5,
                              border: "1px solid var(--line)", borderRadius: 6 }}
                            onChange={(e) => setR(r.id, { [f.key]: e.target.value })} />
                        </label>
                      )
                    ))}
                  </div>

                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
                    {/* 程序按类型自动判定，人工可覆盖 */}
                    <span className="hint">
                      自动判定：{judged.pass === null ? "待补充" : judged.pass ? "通过" : "不通过"}
                      　{judged.reason}
                    </span>
                    <span style={{ flex: 1 }} />
                    <span className="hint">人工覆盖：</span>
                    <button className={"btn sm" + (rec.pass_override === true ? " ok" : " ghost")}
                      onClick={() => setR(r.id, { pass_override: rec.pass_override === true ? null : true })}>通过</button>
                    <button className={"btn ghost sm" + (rec.pass_override === false ? " danger" : "")}
                      onClick={() => setR(r.id, { pass_override: rec.pass_override === false ? null : false })}>不通过</button>
                  </div>
                  {v && <p className="hint" style={{ margin: "6px 0 0" }}>{v.detail}</p>}
                </>
              );
            })()}
          </div>
        );
      })}
    </>
  );
}
