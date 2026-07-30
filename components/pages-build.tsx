"use client";
import { useEffect, useRef, useState } from "react";

/** 失效横幅：仅当「该产物已存在」且「被标记 stale」时显示。
 *  产物从未生成过时提示"已过期"没有意义，反而让人以为出错了。 */
/** 各规则的可执行修复路径 —— 让"存在阻断项"变成"知道下一步做什么" */
const FIX_HINTS: Record<string, string> = {
  POWER_BUDGET_EXCEEDED: "① 在下方电源树把该轨预算改大（同时换用更大电流的 DC-DC/LDO）；② 或把大电流模块（视觉、电机）挪到独立电源轨；③ 或在方案页替换为更省电的模块。",
  POWER_BUDGET_TIGHT: "建议留 20~30% 裕量：把该轨预算调大，或确认电源芯片实际输出能力。",
  POWER_DATA_MISSING: "到「电赛模块」打开该模块补录典型/峰值电流（功率类器件建议实测）。缺数据时预算无法核算。",
  LEVEL_5V_INTO_3V3: "加电平转换芯片（如 TXS0108E）或分压电阻；也可在方案页替换为 5V 容忍的模块。",
  LEVEL_MISMATCH: "确认接收端是否 5V 容忍；不确定就加电平转换或分压。",
  LEVEL_LOW_DRIVE_HIGH: "核对接收端 VIH 阈值；不满足时加比较器/运放缓冲，或换电平匹配的模块。",
  PIN_CONFLICT: "同一输入被多个源驱动：加多路选择开关（如 CD4051）、改用不同引脚，或在方案页替换模块。",
  PIN_FANOUT: "通常无需处理；负载较重时核对驱动能力或加缓冲器。",
  BAUDRATE_MISMATCH: "统一两端波特率，或在代码生成时明确指定。",
  MOTOR_LOGIC_ISOLATION: "为电机单开一条动力轨（与逻辑电源分离），并加大电容/磁珠隔离。",
};

export function StaleBanner({ ctx, types, label, exists }: { ctx: any; types: string[]; label: string; exists?: boolean }) {
  if (exists === false) return null;
  if (!types.some((t) => ctx.staleTypes?.includes(t))) return null;
  return <div className="issue warning" style={{ display: "block", marginBottom: 12 }}>⚠ 主方案已变更，{label}可能已过期 —— 建议重新生成后再使用。</div>;
}

/* ============ 方案框图（SVG 自动布局）============
   输入：solution.blocks / connections。布局：输入类在左列、
   主控在中列、输出/通信在右列、电源在底行；连线按接口预检
   问题着色（阻断红 / 警告琥珀 / 正常蓝）。 */
function roleBucket(b: any): "in" | "core" | "out" | "power" {
  const s = `${b.role || ""} ${b.name || ""} ${b.module_id || ""}`.toLowerCase();
  if (/power|电源|buck|boost|ldo/.test(s)) return "power";
  if (/mcu|dsp|fpga|control|主控|controller/.test(s)) return "core";
  if (/motor|actuator|display|comm|wireless|驱动|执行|显示|通信|dac|输出/.test(s)) return "out";
  return "in";
}
export function BlockDiagram({ solution, ctx }: { solution: any; ctx?: any }) {
  // 画布平移/缩放 + 节点手动摆位
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const nodeDrag = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState(false);
  const [picked, setPicked] = useState<any>(null);
  // 用户手动调整的节点坐标（覆盖自动布局），随方案一起持久化
  const [custom, setCustom] = useState<Record<string, { x: number; y: number }>>(solution.layout || {});
  useEffect(() => { setCustom(solution.layout || {}); }, [solution.solution_id, solution.layout]);
  const blocks: any[] = solution.blocks || [];
  const conns: any[] = solution.connections || [];
  const issues: any[] = solution.integration_precheck?.issues || [];
  const buckets: Record<string, any[]> = { in: [], core: [], out: [], power: [] };
  blocks.forEach((b) => buckets[roleBucket(b)].push(b));
  // 布局参数
  const W = 168, H = 52, GX = 90, GY = 16;
  const colX: Record<string, number> = { in: 10, core: 10 + W + GX, out: 10 + 2 * (W + GX) };
  const pos = new Map<string, { x: number; y: number }>();
  let maxRows = 1;
  (["in", "core", "out"] as const).forEach((c) => {
    buckets[c].forEach((b, i) => pos.set(b.block_id, { x: colX[c], y: 12 + i * (H + GY) }));
    maxRows = Math.max(maxRows, buckets[c].length);
  });
  const powerY = 12 + maxRows * (H + GY) + 8;
  buckets.power.forEach((b, i) => pos.set(b.block_id, { x: 10 + i * (W + GX), y: powerY }));
  const width = 10 + 3 * W + 2 * GX + 10;
  const height = powerY + (buckets.power.length ? H + 14 : 4);

  // 连线端点匹配："K230.UART1_TX" → 匹配名称/模块 id 含 K230 的方块
  function findBlock(endpoint: string): any | null {
    const token = String(endpoint).split(".")[0].toLowerCase();
    return blocks.find((b) => `${b.name} ${b.module_id} ${b.block_id}`.toLowerCase().includes(token)) || null;
  }
  // 用户手动坐标优先于自动布局
  for (const [id, p] of Object.entries(custom)) {
    if (pos.has(id)) pos.set(id, p as any);
  }

  function connColor(c: any): string {
    const hit = issues.find((is) => is.where && String(is.where).includes(String(c.from)) && String(is.where).includes(String(c.to)));
    if (hit?.severity === "blocker") return "#dc2626";
    if (hit?.severity === "warning") return "#d97706";
    return "#3b82f6";
  }
  const bucketFill: Record<string, string> = { in: "#eef6ff", core: "#dbeafe", out: "#eef2ff", power: "#fef6e7" };
  const bucketStroke: Record<string, string> = { in: "#93c5fd", core: "#2563eb", out: "#a5b4fc", power: "#f0c26a" };

  function onDown(e: React.MouseEvent) {
    drag.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
    setDragging(true);
  }
  function onNodeDown(e: React.MouseEvent, b: any) {
    e.stopPropagation();
    const p = pos.get(b.block_id);
    if (!p) return;
    nodeDrag.current = { id: b.block_id, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false };
  }
  function onMove(e: React.MouseEvent) {
    if (nodeDrag.current) {
      const d = nodeDrag.current;
      const dx = (e.clientX - d.sx) / view.k, dy = (e.clientY - d.sy) / view.k;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
      setCustom((c) => ({ ...c, [d.id]: { x: Math.round(d.ox + dx), y: Math.round(d.oy + dy) } }));
      return;
    }
    if (!drag.current) return;
    setView((v) => ({ ...v, x: drag.current!.ox + (e.clientX - drag.current!.sx), y: drag.current!.oy + (e.clientY - drag.current!.sy) }));
  }
  function onUp() {
    if (nodeDrag.current?.moved) {
      // 摆位结果随方案持久化（下次打开保持）
      ctx?.saveLayout?.(solution.solution_id, { ...custom });
    }
    nodeDrag.current = null;
    drag.current = null;
    setDragging(false);
  }
  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    setView((v) => ({ ...v, k: Math.min(2.5, Math.max(0.4, v.k * (e.deltaY < 0 ? 1.1 : 0.9))) }));
  }
  // 点击功能块 → 弹出模块详情（库里有资料就展示完整资料）
  function openBlock(b: any) {
    const mod = b.module_id && ctx?.modules?.find((m: any) => m.id === b.module_id);
    setPicked(mod || { _fallback: true, ...b });
  }

  return (
    <div className="diagram">
      <div className="diagram-toolbar">
        <button onClick={() => setView((v) => ({ ...v, k: Math.min(2.5, v.k * 1.2) }))}>＋ 放大</button>
        <button onClick={() => setView((v) => ({ ...v, k: Math.max(0.4, v.k / 1.2) }))}>－ 缩小</button>
        <button onClick={() => setView({ x: 0, y: 0, k: 1 })}>⟳ 视图复位</button>
        {Object.keys(custom).length > 0 && (
          <button onClick={() => { setCustom({}); ctx?.saveLayout?.(solution.solution_id, {}); }}>↺ 恢复自动布局</button>
        )}
        <span className="hint">拖动模块可调位置 · 拖动空白平移 · 滚轮缩放 · 点击模块看说明</span>
      </div>
      <div className={"diagram-canvas" + (dragging ? " dragging" : "")}
        onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onWheel={onWheel}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`方案 ${solution.name} 框图`}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, transformOrigin: "0 0" }}>
        {conns.map((c, i) => {
          const fb = findBlock(c.from), tb = findBlock(c.to);
          if (!fb || !tb) return null;
          const p1 = pos.get(fb.block_id)!, p2 = pos.get(tb.block_id)!;
          const x1 = p1.x + (p2.x >= p1.x ? W : 0), y1 = p1.y + H / 2;
          const x2 = p2.x + (p2.x >= p1.x ? 0 : W), y2 = p2.y + H / 2;
          const mx = (x1 + x2) / 2;
          const col = connColor(c);
          return (
            <g key={i}>
              <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke={col} strokeWidth={1.6} />
              <circle cx={x2} cy={y2} r={2.6} fill={col} />
              <text x={mx} y={(y1 + y2) / 2 - 5} textAnchor="middle" fontSize="9.5" fill={col} fontFamily="ui-monospace,monospace">
                {c.protocol}{c.baudrate ? `@${c.baudrate >= 1e6 ? c.baudrate / 1e6 + "M" : c.baudrate / 1e3 + "k"}` : ""}
              </text>
            </g>
          );
        })}
        {blocks.map((b) => {
          const p = pos.get(b.block_id);
          if (!p) return null;
          const bk = roleBucket(b);
          return (
            <g key={b.block_id} style={{ cursor: nodeDrag.current?.id === b.block_id ? "grabbing" : "grab" }}
              onMouseDown={(e) => onNodeDown(e, b)}
              onClick={(e) => { e.stopPropagation(); if (!nodeDrag.current?.moved) openBlock(b); }}>
              <title>{`${b.name}｜拖动可移动位置，点击查看模块说明`}</title>
              <rect x={p.x} y={p.y} width={W} height={H} rx={9} fill={bucketFill[bk]} stroke={bucketStroke[bk]} strokeWidth={bk === "core" ? 2 : 1.2} />
              <text x={p.x + W / 2} y={p.y + 21} textAnchor="middle" fontSize="11.5" fontWeight={700} fill="#1a2333">{b.name}</text>
              <text x={p.x + W / 2} y={p.y + 38} textAnchor="middle" fontSize="9.5" fill="#64748b" fontFamily="ui-monospace,monospace">{b.module_id || b.role}</text>
            </g>
          );
        })}
      </svg>
      </div>
      {picked && <BlockInfoModal item={picked} onClose={() => setPicked(null)} />}
    </div>
  );
}

/* ============ 方案生成（对话式，参考 ai-hardware-genesis 渐进流程）============ */
const CONTEST_CN: Record<string, string> = {
  national: "国赛", provincial: "省赛", invitational: "邀请赛", practice: "练习题",
};
const TECH_CN: Record<string, string> = {
  power: "电源类", signal_source: "信号源类", rf: "高频无线电", amplifier: "放大器类",
  instrument: "仪器仪表", data_acquisition: "数据采集", control: "控制类",
  mechatronic: "机电一体化", sensor: "传感器应用", communication: "通信类",
};

export function SolutionPage({ ctx }: { ctx: any }) {
  const [text, setText] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const solRef = useRef<HTMLDivElement>(null);
  const [showJump, setShowJump] = useState(false);
  useEffect(() => { logRef.current?.scrollTo({ top: 1e9 }); }, [ctx.msgs.length]);

  const solList = ctx.solutions?.solutions || ctx.solutions?.candidate_solutions || [];
  // 方案刚生成时自动滚到方案区（需求清单很长时用户容易不知道下面已有结果）
  useEffect(() => {
    if (solList.length) {
      const t = setTimeout(() => solRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 300);
      return () => clearTimeout(t);
    }
  }, [solList.length]);
  // 方案不在视口内时显示悬浮跳转
  useEffect(() => {
    if (!solList.length) { setShowJump(false); return; }
    const onScroll = () => {
      const r = solRef.current?.getBoundingClientRect();
      setShowJump(!!r && r.top > window.innerHeight - 80);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [solList.length]);

  const step = ctx.chosenSolution ? 3 : ctx.solutions ? 2 : ctx.requirements ? 1 : 0;
  const steps = ["① 需求输入", "② 方案生成", "③ 方案核对", "④ 确认进入 BOM"];

  return (
    <>
      <div className="steps">
        {steps.map((s, i) => (
          <span key={s} className={"st" + (i < step ? " done" : i === step ? " on" : "")}>{s}</span>
        ))}
        {ctx.shortlist.length > 0 && <span className="hint" style={{ marginLeft: "auto" }}>已选用 {ctx.shortlist.length} 个模块将被优先考虑</span>}
      </div>

      {!ctx.requirements && <ProblemPicker ctx={ctx} />}
      {ctx.shortlist?.length > 0 && (
        <div className="issue info" style={{ display: "block", marginBottom: 10 }}>
          🔧 已从「电赛模块」选用 {ctx.shortlist.length} 个模块，生成方案时会优先考虑：
          {ctx.modules.filter((m: any) => ctx.shortlist.includes(m.id)).map((m: any) => m.name).join("、")}
          <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={() => ctx.setShortlist([])}>清空</button>
        </div>
      )}

      {showJump && (
        <button className="jump-fab" onClick={() => solRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
          ⬇ 方案已生成（{solList.length} 套），点此查看
        </button>
      )}

      <div className="solution-wrap">
        {/* 左列（视觉上）：需求 → 方案卡片 */}
        <div style={{ display: "grid", gap: 14 }}>
          {ctx.requirements && <RequirementEditor ctx={ctx} />}

          <div ref={solRef} />
          {solList.length > 0 && (
            <div className="statsbar" style={{ marginBottom: 10 }}>
              ✅ 已生成 {solList.length} 套方案 —— 核对下方框图与接口预检后，点「采用为主方案」继续
            </div>
          )}
          {(ctx.solutions?.dropped_connections > 0 || ctx.solutions?.dropped_power_rails > 0) && (
            <div className="issue warning" style={{ display: "block" }}>
              模型输出中有结构异常项已被剔除：
              {ctx.solutions.dropped_connections > 0 && `${ctx.solutions.dropped_connections} 条连线`}
              {ctx.solutions.dropped_connections > 0 && ctx.solutions.dropped_power_rails > 0 && "、"}
              {ctx.solutions.dropped_power_rails > 0 && `${ctx.solutions.dropped_power_rails} 条电源轨`}
              —— 框图与规则检查基于剩余有效数据，建议核对完整性。
            </div>
          )}
          {ctx.solutions?.partial_output && (
            <div className="issue blocker" style={{ display: "block" }}>
              ⚠ <b>本次输出不完整</b>（曾被截断并自动修复）：{ctx.solutions.truncation_note || "方案可能缺少部分连线或功能块。"}
              <br />确认为主方案前请逐项核对，或直接重新生成。
            </div>
          )}
          {(ctx.solutions?.solutions || ctx.solutions?.candidate_solutions || []).map((sol: any) => {
            const pre = sol.integration_precheck;
            const chosen = ctx.chosenSolution?.solution_id === sol.solution_id;
            return (
              <div key={sol.solution_id} className={"solcard" + (chosen ? " chosen" : "")}>
                <h4>
                  <span className="chip" style={{ fontSize: 12 }}>{sol.solution_id}</span>{sol.name}
                  <span style={{ flex: 1 }} />
                  {pre && (pre.passed
                    ? <span className="chip green">接口预检通过</span>
                    : <span className="chip red">预检 {pre.issues?.filter((i: any) => i.severity === "blocker").length} 阻断</span>)}
                  <span className="chip">{sol.risk_level === "low" ? "低风险" : sol.risk_level === "high" ? "高风险" : "中风险"}</span>
                </h4>
                <p className="hint" style={{ margin: "2px 0 6px" }}>{sol.summary}</p>
                <BlockDiagram solution={sol} ctx={ctx} />
                <div className="prosub">
                  <div className="p"><b>优势</b><ul>{(sol.advantages || []).map((a: string) => <li key={a}>{a}</li>)}</ul></div>
                  <div className="c"><b>代价 / 风险</b><ul>{(sol.disadvantages || []).map((a: string) => <li key={a}>{a}</li>)}</ul></div>
                </div>
                {sol.uncovered_requirements?.length > 0 && (
                  <div className="issue warning">⚠ 未覆盖需求：{sol.uncovered_requirements.join("、")}</div>
                )}
                {sol.coverage && (
                  <p className="hint" style={{ margin: "4px 0" }}>
                    需求覆盖 {sol.coverage.covered}/{sol.coverage.total}
                    {sol.coverage.omitted_from_context?.length > 0 && (
                      <span className="chip gold" style={{ marginLeft: 6 }}>
                        {sol.coverage.omitted_from_context.length} 条因长度未纳入生成上下文
                      </span>
                    )}
                  </p>
                )}
                <BlockList sol={sol} ctx={ctx} />
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", marginTop: 8 }}>
                  {ctx.backupSolution?.solution_id === sol.solution_id && <span className="chip violet">备用方案</span>}
                  {!chosen && <button className="btn ghost sm" onClick={() => ctx.markBackup(sol)}>设为备用</button>}
                  {!chosen && <button className="btn sm" disabled={ctx.busy} onClick={() => ctx.approveSolution(sol)}>采用为主方案</button>}
                  {chosen && <span className="chip green">✓ 主方案 —— 可进入 BOM / 代码</span>}
                  {chosen && ctx.backupSolution && <button className="btn ghost sm" onClick={ctx.swapToBackup}>切换到备用 ⇄</button>}
                </div>
              </div>
            );
          })}

          {!ctx.requirements && (
            <div className="card">
              <h3>怎么开始？</h3>
              <p className="hint">1️⃣ 把赛题原文整段粘贴到左侧对话框发送 —— 助手会先解析成可核对的指标清单，并标出题面歧义等待你确认。<br />
                2️⃣ 确认后点「生成方案」，得到一套完整方案（含框图与接口预检）。<br />
                3️⃣ 核对后点「采用为主方案」，即可继续 BOM、连线检查、代码与报告。<br />
                　　需要写报告的「方案论证」章节时，可再生成稳妥/性能取向的备选方案做对比。<br /><br />
                💡 想让方案优先使用某些手头模块？先去顶栏「电赛模块」点「选用」。</p>
            </div>
          )}
        </div>
        {/* 右列（视觉上）：AI 助手对话，吸顶常驻 */}
        <div className="card chatbox assistant-col">
          <div className="head"><span className="ai">AI</span>设计助手 · 渐进式方案发现</div>
          <div className="chatlog" ref={logRef}>
            {ctx.msgs.map((m: any, i: number) => (
              <div key={i} className={"bubble " + m.who}>{m.text}</div>
            ))}
            {ctx.busy && <div className="bubble agent"><span className="spinner" /> 思考中…</div>}
          </div>
      </div>
          <div className="quickrow">
            {ctx.requirements && !ctx.solutions && (
              <button className="btn sm" disabled={ctx.busy} onClick={() => ctx.runSolution()}>生成方案</button>
            )}
            {ctx.solutions && (
              <>
                <button className="btn ghost sm" disabled={ctx.busy} onClick={() => ctx.runSolution("safe")}>＋ 备选（稳妥）</button>
                <button className="btn ghost sm" disabled={ctx.busy} onClick={() => ctx.runSolution("performance")}>＋ 备选（性能）</button>
              </>
            )}
            {ctx.requirements && (
              <button className="btn ghost sm" disabled={ctx.busy} onClick={() => ctx.runInterpret(ctx.problemText)}>重新解析赛题</button>
            )}
            {ctx.chosenSolution && (
              <button className="btn ghost sm" onClick={() => ctx.setPage("wiring")}>去电路连线检查 →</button>
            )}
          </div>
          <div className="chatin">
            <textarea value={text} placeholder="粘贴赛题原文，或描述设计需求 / 向助手提问…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ctx.chat(text); setText(""); } }} />
            <button className="btn" disabled={ctx.busy || !text.trim()} onClick={() => { ctx.chat(text); setText(""); }}>发送</button>
          </div>
        </div>
    </>
  );
}

/* ============ 电路连线与接口检查 ============ */
export function WiringPage({ ctx }: { ctx: any }) {
  const sol = ctx.chosenSolution;
  const rep = ctx.wiringReport || sol?.integration_precheck;
  if (!sol) return <div className="card"><p className="hint">请先在「方案生成」页确认一套方案，这里将展示它的连线表并运行接口 / 电源规则检查。</p></div>;
  return (
    <>
    <StaleBanner ctx={ctx} types={["integration_report"]} label="接口检查结果" exists={!!ctx.wiringReport} />
    <div className="grid cols-2" style={{ alignItems: "start" }}>
      <div style={{ display: "grid", gap: 14 }}>
        <div className="card">
          <h3>方案连线 · {sol.name}</h3>
          <BlockDiagram solution={{ ...sol, integration_precheck: rep }} ctx={ctx} />
          <table className="data">
            <thead><tr><th>从</th><th>到</th><th>协议</th><th>电平</th><th>速率</th></tr></thead>
            <tbody>
              {(sol.connections || []).map((c: any, i: number) => (
                <tr key={i}>
                  <td>{c.from}</td><td>{c.to}</td><td>{c.protocol}</td>
                  <td>{c.voltage_from}V → {c.voltage_to}V</td>
                  <td>{c.baudrate ? c.baudrate.toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {sol.power_tree?.length > 0 && (
          <div className="card">
            <h3>电源树 <span className="hint" style={{ fontWeight: 400 }}>预算可直接改 —— 电源类阻断多数靠调预算或换更大电源解决</span></h3>
            <table className="data">
              <thead><tr><th>电源轨</th><th>电压</th><th>来源</th><th>负载</th><th>预算 (mA)</th></tr></thead>
              <tbody>
                {sol.power_tree.map((p: any) => (
                  <tr key={p.rail}>
                    <td><b>{p.rail}</b></td><td>{p.voltage}V</td><td>{p.source}</td>
                    <td className="hint">{(p.loads || []).join("、")}</td>
                    <td>
                      <input type="number" min={0} step={100} defaultValue={p.budget_ma} disabled={ctx.busy}
                        style={{ width: 92, padding: 4, border: "1px solid var(--line)", borderRadius: 6 }}
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (v && v !== p.budget_ma) ctx.updatePowerRail?.(p.rail, { budget_ma: v });
                        }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint" style={{ marginTop: 6 }}>改完失去焦点即自动重跑规则检查。模块实际功耗未知时，请到「电赛模块」补录典型/峰值电流。</p>
          </div>
        )}
      </div>

      <div className="card">
        <h3>规则检查结果
          <button className="btn sm" style={{ marginLeft: "auto" }} disabled={ctx.busy} onClick={ctx.runWiringCheck}>
            {ctx.busy ? "检查中…" : "重新运行检查"}
          </button>
        </h3>
        <p className="hint">电平容忍 / 引脚冲突 / 波特率 / 电源预算 / 动力隔离 —— 全部为确定性规则，不经过大模型。存在阻断项时代码生成将被拦截。</p>
        {rep ? (
          <>
            <div className={"issue " + (rep.passed ? "info" : "blocker")} style={{ fontWeight: 700 }}>
              {rep.passed ? `✓ 检查通过（${rep.checked_connections ?? sol.connections?.length ?? 0} 条连线）` : "✗ 存在阻断项，禁止进入代码生成"}
            </div>
            {(rep.issues || []).map((is: any, i: number) => (
              <div key={i} className={"issue " + is.severity}>
                <span className="tag">{is.severity === "blocker" ? "阻断" : is.severity === "warning" ? "警告" : "提示"}·{is.rule}</span>
                <span>{is.message}<br /><span className="hint">{is.where}</span>
                  {FIX_HINTS[is.rule] && <><br /><span className="hint">🔧 怎么修：{FIX_HINTS[is.rule]}</span></>}
                </span>
              </div>
            ))}
          </>
        ) : <p className="hint">点「重新运行检查」执行完整规则检查。</p>}
        <div className="issue info" style={{ marginTop: 12 }}>📐 原理图 / PCB 在线编辑为二期功能；当前阶段以连线级检查保证方案电气正确性。</div>
      </div>
    </div>
    </>
  );
}

/* ============ 代码生成 ============ */
export function CodePage({ ctx }: { ctx: any }) {
  const [target, setTarget] = useState("");
  const [active, setActive] = useState(0);
  const [err, setErr] = useState("");
  const [buildJob, setBuildJob] = useState<any>(null);
  const [building, setBuilding] = useState(false);

  async function submitBuild(buildTarget: string) {
    if (!ctx.codeBundle?.files?.length) return;
    setBuilding(true);
    const r = await fetch("/api/build-jobs", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: ctx.projectId, target: buildTarget, files: ctx.codeBundle.files }) }).then((x) => x.json());
    if (!r.job_id) { setErr(r.error || "提交失败"); setBuilding(false); return; }
    setBuildJob({ job_id: r.job_id, status: "queued" });
    // 轮询直到终态（执行器在 CI / 本地跑）
    const t0 = Date.now();
    while (Date.now() - t0 < 40 * 60_000) {
      await new Promise((rs) => setTimeout(rs, 5000));
      const j = await fetch(`/api/build-jobs/${r.job_id}`).then((x) => x.json()).catch(() => null);
      if (j?.status && !["queued", "running"].includes(j.status)) {
        setBuildJob(j);
        if (["MINIMAL_LINKED", "SOURCE_COMPILED"].includes(j.status)) {
          await ctx.runVerify?.();   // 静态验证在前
          await fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: "code_verifier", project_id: ctx.projectId,
              input: { files: ctx.codeBundle.files, external_status: j.status,
                external_evidence: `build_job:${j.job_id}${j.flash_bytes != null ? ` flash=${j.flash_bytes}B ram=${j.ram_bytes}B` : ""}` } }) });
        }
        break;
      }
      if (j) setBuildJob(j);
    }
    setBuilding(false);
  }
  const b = ctx.codeBundle;
  const files = b?.files || [];
  // 功能块来源：已确认方案 → 候选方案列表兜底（方案确认后 blocks 应始终存在）
  const solBlocks: any[] = ctx.chosenSolution?.blocks
    || (ctx.solutions?.solutions || ctx.solutions?.candidate_solutions || [])
        .find((s: any) => s.solution_id === ctx.chosenSolution?.solution_id)?.blocks
    || [];
  const mcu = solBlocks.find((bl: any) => /mcu|主控|controller/i.test(`${bl.role} ${bl.name}`));
  return (
    <>
    <StaleBanner ctx={ctx} types={["code_bundle", "code_verification"]} label="生成的代码" exists={!!ctx.codeBundle?.files?.length} />
    {ctx.codeBundle?.partial_output && (
      <div className="issue blocker" style={{ display: "block", marginBottom: 12 }}>
        ⚠ <b>代码可能不完整</b>：输出曾被截断修复，末尾文件可能缺少收尾。请先点「静态验证」确认括号配平后再使用。
      </div>
    )}
    <div className="code-wrap">
      <div className="card">
        <h3>工程文件</h3>
        <div className="filetree">
          {files.map((f: any, i: number) => (
            <button key={f.path} className={active === i ? "on" : ""} onClick={() => setActive(i)}>{f.path}</button>
          ))}
          {!files.length && <span className="hint">生成后这里显示分层的固件文件树。</span>}
        </div>
        {b?.plan?.length > 0 && (
          <>
            <h4 style={{ marginBottom: 4 }}>分层结构</h4>
            {b.plan.map((p: any) => <div key={p.layer} className="hint">▸ {p.layer}：{p.files.join("、")}</div>)}
          </>
        )}
      </div>

      <div className="codeview">
        <div className="tab">{files[active]?.path || "main.c"}</div>
        <pre>{files[active]?.content || "// 在右侧选择目标模块并点「生成代码」\n// 生成的代码状态为 GENERATED：\n// 编译通过前不会被标记为可用。"}</pre>
      </div>

      <div className="card">
        <h3>代码配置</h3>
        <p className="hint">开发平台：<b>{mcu ? `${mcu.name}（${mcu.module_id || ""}）` : "未确认方案"}</b></p>
        <label className="hint">目标模块（留空自动选择）{solBlocks.length > 0 && <> · 共 {solBlocks.length} 个功能块</>}</label>
        <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid var(--line)", margin: "4px 0 10px" }}>
          <option value="">— 自动 —</option>
          {solBlocks.map((bl: any) => (
            <option key={bl.block_id} value={bl.module_id || bl.name}>{bl.name}{bl.module_id ? ` (${bl.module_id})` : ""}</option>
          ))}
        </select>
        <button className="btn" style={{ width: "100%" }} onClick={async () => {
          setErr("");
          const r = await ctx.runCode(target);
          if (!r.ok) setErr(r.message || "生成失败");
          else setActive(0);
        }} disabled={ctx.busy || !ctx.chosenSolution}>{ctx.busy ? "生成中…" : "⚡ 生成代码"}</button>
        {!ctx.chosenSolution && (
          <p className="hint" style={{ marginTop: 6 }}>
            需要先在「方案生成」确认一套主方案 —— 代码要依据方案里的主控型号、
            引脚分配与外设资源生成，否则只能产出通用模板。
          </p>
        )}
        {err && <div className="issue blocker" style={{ marginTop: 10 }}>{err}</div>}
        {b && (
          <>
            <div className="issue info" style={{ marginTop: 10, display: "block" }}>
              验证状态：<b>{b.verification_status}</b>
              <div style={{ display: "flex", gap: 3, margin: "6px 0", flexWrap: "wrap" }}>
                {["GENERATED", "SYNTAX_CHECKED", "SOURCE_COMPILED", "MINIMAL_LINKED", "SDK_BUILD_PASSED", "HIL_TESTED"].map((st) => (
                  <span key={st} className={"chip" + (b.verification_status === st ? " green" : "")} style={{ fontSize: 10 }}>{st}</span>
                ))}
              </div>
              MINIMAL_LINKED=最小链接出 ELF，≠厂商工程可烧录构建（那需要 SDK_BUILD_PASSED）。
            </div>
            <button className="btn ghost" style={{ width: "100%", marginTop: 8 }} disabled={ctx.busy} onClick={ctx.runVerify}>🔍 静态验证</button>
            {b.verify_issues?.length > 0 && b.verify_issues.map((is: any, i: number) => (
              <div key={i} className={"issue " + (is.severity === "error" ? "blocker" : "warning")} style={{ marginTop: 6 }}>
                <span className="tag">{is.file}</span><span>{is.message}</span>
              </div>
            ))}
            {b.honest_note && <p className="hint" style={{ marginTop: 6 }}>{b.honest_note}</p>}
            <div style={{ borderTop: "1px solid var(--line)", marginTop: 12, paddingTop: 10 }}>
              <b style={{ fontSize: 13 }}>真实编译（build_jobs）</b>
              <p className="hint">交叉编译由执行器完成（GitHub Actions 每 30 分钟巡队列，或本地 <code>npm run build:runner</code>）。成功后自动晋级 COMPILED 并给出 Flash/RAM。</p>
              <div style={{ display: "flex", gap: 6 }}>
                {["mspm0", "stm32", "esp32"].map((t) => (
                  <button key={t} className="btn ghost sm" disabled={building} onClick={() => submitBuild(t)}>编译 {t.toUpperCase()}</button>
                ))}
              </div>
              {buildJob && (
                <div className="issue info" style={{ marginTop: 8, display: "block" }}>
                  任务 {buildJob.job_id}：<b>{buildJob.status}</b>
                  {building && <span className="spinner" style={{ marginLeft: 6 }} />}
                  {buildJob.flash_bytes != null && <> · Flash {buildJob.flash_bytes}B / RAM {buildJob.ram_bytes}B</>}
                  {buildJob.has_bin && <> · <a href={`/api/build-jobs/${buildJob.job_id}?bin=1`} download>下载 BIN</a></>}
                  {buildJob.log && <details style={{ marginTop: 4 }}><summary>编译日志</summary><pre style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>{buildJob.log}</pre></details>}
                </div>
              )}
            </div>
            {b.unsupported_items?.length > 0 && (
              <div className="issue warning">以下内容无法可靠生成（不编造 API）：{b.unsupported_items.join("、")}</div>
            )}
          </>
        )}
      </div>
    </div>
    </>
  );
}

/* ============ 调试助手 ============ */
export function DebugPage({ ctx }: { ctx: any }) {
  const [symptom, setSymptom] = useState("");
  const [logs, setLogs] = useState("");
  const [images, setImages] = useState<{ media_type: string; data_base64: string; name: string }[]>([]);
  const [err, setErr] = useState("");
  const s = ctx.debugSession;

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => setImages((im) => [...im, { media_type: f.type, data_base64: String(rd.result).split(",")[1], name: f.name }]);
    rd.readAsDataURL(f);
  }

  return (
    <div className="grid cols-2" style={{ alignItems: "start" }}>
      <div className="card">
        <h3>报告故障</h3>
        <label className="hint">现象描述</label>
        <textarea className="area" rows={3} value={symptom} onChange={(e) => setSymptom(e.target.value)}
          placeholder="例：电机一启动 MCU 就复位；示波器看 3.3V 轨跌到 2.6V…" />
        <label className="hint">串口日志 / 测量数据（可选）</label>
        <textarea className="area" rows={4} value={logs} onChange={(e) => setLogs(e.target.value)} placeholder="粘贴串口输出、示波器读数…" />
        <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
          <label className="btn ghost sm" style={{ display: "inline-block" }}>
            📷 上传照片（板卡 / 波形）
            <input type="file" accept="image/*" hidden onChange={onFile} />
          </label>
          {images.map((im, i) => <span key={i} className="chip">{im.name} ✕<button style={{ border: 0, background: "none", cursor: "pointer" }} onClick={() => setImages((a) => a.filter((_, j) => j !== i))} aria-label="移除" /></span>)}
        </div>
        <button className="btn" disabled={ctx.busy || !symptom.trim()} onClick={async () => {
          setErr("");
          const r = await ctx.runDebug(symptom, logs, images.map(({ name, ...rest }) => rest));
          if (!r.ok) setErr(r.message || "分析失败");
        }}>{ctx.busy ? "分析中…" : "开始诊断"}</button>
        {err && <div className="issue blocker" style={{ marginTop: 10 }}>{err}</div>}
        {s && <p className="hint" style={{ marginTop: 10 }}>🔁 这是循环调试：按右侧指引测量后，把新结果继续提交，假设会随证据收敛。</p>}
        <div className="issue info" style={{ marginTop: 10 }}>🧪 示波器 / 串口实时接入为二期「实验平台」功能。</div>
      </div>

      <div style={{ display: "grid", gap: 14 }}>
        {s?.safety_warnings?.length > 0 && s.safety_warnings.map((w: string, i: number) => (
          <div key={i} className="issue blocker">⚡ 安全：{w}</div>
        ))}
        <div className="card">
          <h3>故障假设（按置信度）</h3>
          {(s?.hypotheses || []).map((h: any, i: number) => (
            <div key={i} className="hyp">
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5 }}>
                <span>{h.cause || h.hypothesis || h.text}</span>
                <b>{Math.round((h.confidence ?? 0) * 100)}%</b>
              </div>
              <div className="bar"><i style={{ width: `${(h.confidence ?? 0) * 100}%` }} /></div>
              {h.rationale && <p className="hint" style={{ margin: "3px 0 0" }}>{h.rationale}</p>}
            </div>
          ))}
          {!s && <p className="hint">诊断后这里显示带置信度的故障树。</p>}
        </div>
        {s?.next_measurements?.length > 0 && (
          <div className="card">
            <h3>下一步测量动作</h3>
            <table className="data">
              <thead><tr><th>#</th><th>测什么</th><th>预期 / 判据</th></tr></thead>
              <tbody>
                {s.next_measurements.map((m: any, i: number) => (
                  <tr key={i}><td>{i + 1}</td><td>{m.action || m.measure || m.text}</td><td>{m.expected || m.criteria || "—"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============ 报告生成 ============ */
const CHAPTERS = ["题目分析与摘要", "方案论证与比较", "系统总体设计", "理论分析与计算", "电路与程序设计", "测试方案与结果", "结论", "附录"];
export function ReportPage({ ctx }: { ctx: any }) {
  const [incBom, setIncBom] = useState(true);
  const [incCode, setIncCode] = useState(true);
  const [incDebug, setIncDebug] = useState(false);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [draft, setDraft] = useState("");
  const [saveMsg, setSaveMsg] = useState("");
  const r = ctx.report;
  const md: string = r?.markdown || r?.content || "";

  useEffect(() => { setDraft(md); }, [md]);

  async function save() {
    setSaveMsg("保存中…");
    const res = await fetch("/api/report/export", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: ctx.projectId, markdown: draft }),
    }).then((x) => x.json()).catch(() => null);
    if (res?.version) {
      ctx.setReport?.({ ...(r || {}), markdown: draft, edited_by_user: true });
      setSaveMsg(`已保存为第 ${res.version} 版`);
      setMode("preview");
    } else setSaveMsg(res?.error || "保存失败");
    setTimeout(() => setSaveMsg(""), 4000);
  }

  function printPdf() {
    // 用浏览器打印导出 PDF：中文字体最可靠，且用户可选纸张与页边距
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${r?.title || "电赛设计报告"}</title>
<style>
  body { font-family: "Microsoft YaHei","PingFang SC",sans-serif; line-height: 1.75; max-width: 780px; margin: 40px auto; color: #1a2333; }
  h1 { font-size: 22px; border-bottom: 2px solid #2563eb; padding-bottom: 8px; }
  h2 { font-size: 17px; margin-top: 26px; color: #14274e; }
  h3 { font-size: 15px; margin-top: 18px; }
  pre { background: #f5f7fa; padding: 10px; border-radius: 6px; overflow-x: auto; font-size: 12px; }
  code { background: #f5f7fa; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 13px; }
  th, td { border: 1px solid #d8e0ee; padding: 6px 9px; text-align: left; }
  th { background: #eef2ff; }
  blockquote { border-left: 3px solid #cbd5e1; margin: 0; padding-left: 12px; color: #64748b; }
  @media print { body { margin: 0; max-width: none; } }
</style></head><body>${mdToHtml(draft || md)}
<script>window.onload=()=>{window.print()}<\/script></body></html>`);
    w.document.close();
  }

  return (
    <div className="grid" style={{ gridTemplateColumns: "1fr 300px", alignItems: "start" }}>
      {/* 左：预览 / 编辑 */}
      <div style={{ display: "grid", gap: 14 }}>
        {r?.consistency_issues?.length > 0 && (
          <div className="card">
            <h3>一致性检查（{r.consistency_issues.length} 处需核实）</h3>
            {r.consistency_issues.map((c: any, i: number) => (
              <div key={i} className="issue warning">⚠ {typeof c === "string" ? c : c.message || JSON.stringify(c)}</div>
            ))}
          </div>
        )}

        {md ? (
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--line)" }}>
              <button className={"btn sm" + (mode === "preview" ? "" : " ghost")} onClick={() => setMode("preview")}>👁 预览</button>
              <button className={"btn sm" + (mode === "edit" ? "" : " ghost")} onClick={() => setMode("edit")}>✏️ 编辑</button>
              {mode === "edit" && <button className="btn sm ok" onClick={save}>💾 保存</button>}
              {mode === "edit" && draft !== md && <span className="chip gold">未保存</span>}
              <span className="hint" style={{ marginLeft: "auto" }}>
                {saveMsg || `${(draft || md).length} 字${r?.edited_by_user ? " · 已人工编辑" : ""}`}
              </span>
            </div>
            {mode === "preview" ? (
              <div className="report-preview" dangerouslySetInnerHTML={{ __html: mdToHtml(draft || md) }} />
            ) : (
              <textarea className="report-editor" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
            )}
          </div>
        ) : (
          <div className="card">
            <h3>还没有生成报告</h3>
            <p className="hint">报告会基于已确认的方案、结构化需求、BOM 与测试数据撰写，遵循电赛设计报告章节规范。缺失的测试数据以【待补充】占位，不会编造数值。</p>
          </div>
        )}
      </div>

      {/* 右：章节导航 + 生成选项 + 导出 */}
      <div style={{ display: "grid", gap: 14, position: "sticky", top: 12 }}>
        <div className="card">
          <h3>生成选项</h3>
          <div className="tasklist">
            <label><input type="checkbox" checked={incBom} onChange={() => setIncBom(!incBom)} />包含 BOM 元件清单</label>
            <label><input type="checkbox" checked={incCode} onChange={() => setIncCode(!incCode)} />包含代码文件清单</label>
            <label><input type="checkbox" checked={incDebug} onChange={() => setIncDebug(!incDebug)} />包含调试记录</label>
          </div>
          <button className="btn" style={{ width: "100%", marginTop: 12 }} onClick={async () => {
            setErr("");
            const res = await ctx.runReport({ includeBom: incBom, includeCode: incCode, includeDebug: incDebug });
            if (!res.ok) setErr(res.message || "生成失败");
          }} disabled={ctx.busy || !ctx.chosenSolution}>{ctx.busy ? "撰写中…" : md ? "🔄 重新生成" : "📄 生成报告"}</button>
          {!ctx.chosenSolution && (
            <p className="hint" style={{ marginTop: 6 }}>
              需要先确认主方案 —— 报告的方案论证、系统设计、理论分析章节都基于它，
              缺少时只能生成空壳。
            </p>
          )}
          {err && <div className="issue blocker" style={{ marginTop: 10 }}>{err}</div>}
          {md && ctx.projectId && (
            <>
              <p className="hint" style={{ margin: "12px 0 6px" }}>导出（含你的编辑内容，先保存）</p>
              <div style={{ display: "grid", gap: 6 }}>
                <a className="btn ghost sm" style={{ textAlign: "center", textDecoration: "none" }}
                  href={`/api/report/export?project_id=${ctx.projectId}&format=docx`}>⬇ Word (.docx)</a>
                <button className="btn ghost sm" onClick={printPdf}>⬇ PDF（打印导出）</button>
                <a className="btn ghost sm" style={{ textAlign: "center", textDecoration: "none" }}
                  href={`/api/report/export?project_id=${ctx.projectId}&format=md`}>⬇ Markdown (.md)</a>
              </div>
            </>
          )}
          <p className="hint" style={{ marginTop: 10 }}>缺失测试数据以【待补充】占位，不编造数值；生成后自动做型号一致性检查。</p>
        </div>
        <div className="card">
          <h3>报告章节（电赛规范）</h3>
          {CHAPTERS.map((c, i) => <div key={c} className="chapter"><span className="n">{i + 1}</span>{c}</div>)}
        </div>
      </div>
    </div>
  );
}

/** 轻量 Markdown → HTML（预览与打印共用；仅覆盖报告用到的语法） */
function mdToHtml(md: string): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (t: string) => esc(t)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0, inList = false, listTag = "ul";
  const closeList = () => { if (inList) { out.push(`</${listTag}>`); inList = false; } };

  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      closeList();
      const body: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { closeList(); out.push("<hr/>"); i++; continue; }
    if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeList();
      const cells = (x: string) => x.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(l); i += 2;
      const body: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { body.push(cells(lines[i])); i++; }
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${
        body.map((rw) => `<tr>${rw.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const li = l.match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[1]);
      if (!inList) { listTag = ordered ? "ol" : "ul"; out.push(`<${listTag}>`); inList = true; }
      out.push(`<li>${inline(li[2])}</li>`); i++; continue;
    }
    if (!l.trim()) { closeList(); i++; continue; }
    closeList();
    out.push(`<p>${inline(l)}</p>`); i++;
  }
  closeList();
  return out.join("\n");
}

/* ============ 需求编辑器（逐条编辑 / 确认 / 驳回）============ */
const REQ_STATUS_UI: Record<string, [string, string]> = {
  AI_EXTRACTED: ["AI 提取", "chip"], NEEDS_REVIEW: ["待核对", "chip gold"], AMBIGUOUS: ["歧义", "chip gold"],
  CONFIRMED: ["已确认", "chip green"], REJECTED: ["已驳回", "chip red"],
};
function RequirementEditor({ ctx }: { ctx: any }) {
  const list: any[] = ctx.requirements?.requirements || [];
  const [editing, setEditing] = useState<string | null>(null);
  const mand = list.filter((r) => r.priority === "mandatory" && r.status !== "REJECTED");
  const confirmed = mand.filter((r) => r.status === "CONFIRMED").length;
  const allConfirmed = confirmed === mand.length && mand.length > 0;

  return (
    <div className="card">
      <h3>需求清单
        <span className="hint" style={{ fontWeight: 400 }}>基本要求已确认 {confirmed}/{mand.length}</span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={ctx.addRequirement}>＋ 补充需求</button>
        <button className="btn sm" onClick={ctx.confirmAllExtracted}>全部确认</button>
      </h3>
      <div className="progress"><i style={{ width: `${mand.length ? (confirmed / mand.length) * 100 : 0}%` }} /></div>
      {!allConfirmed && <p className="hint">⚠ 所有基本要求逐条确认后才能生成正式方案 —— 第一步解析错了，后面的方案 / BOM / 代码 / 报告会一路错下去。</p>}

      {list.map((r) => {
        const [label, cls] = REQ_STATUS_UI[r.status || "AI_EXTRACTED"] || ["?", "chip"];
        const isEdit = editing === r.id;
        return (
          <div key={r.id} className="req-item" style={{ flexWrap: "wrap", opacity: r.status === "REJECTED" ? 0.5 : 1 }}>
            <span className="rid">{r.id}</span>
            {isEdit ? (
              <span style={{ flex: 1, display: "grid", gap: 5 }}>
                <input value={r.description} onChange={(e) => ctx.updateRequirement(r.id, { description: e.target.value })}
                  style={{ padding: 5, border: "1px solid var(--line)", borderRadius: 6, width: "100%" }} />
                <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <input value={r.target ?? ""} placeholder="指标" style={{ width: 76, padding: 4, border: "1px solid var(--line)", borderRadius: 6 }}
                    onChange={(e) => ctx.updateRequirement(r.id, { target: e.target.value })} />
                  <input value={r.unit ?? ""} placeholder="单位" style={{ width: 56, padding: 4, border: "1px solid var(--line)", borderRadius: 6 }}
                    onChange={(e) => ctx.updateRequirement(r.id, { unit: e.target.value })} />
                  <input value={r.tolerance ?? ""} placeholder="误差 ±1%" style={{ width: 80, padding: 4, border: "1px solid var(--line)", borderRadius: 6 }}
                    onChange={(e) => ctx.updateRequirement(r.id, { tolerance: e.target.value })} />
                  <select value={r.priority} onChange={(e) => ctx.updateRequirement(r.id, { priority: e.target.value })}
                    style={{ padding: 4, border: "1px solid var(--line)", borderRadius: 6 }}>
                    <option value="mandatory">基本要求</option><option value="bonus">发挥部分</option>
                  </select>
                  <select value={r.verification_method} onChange={(e) => ctx.updateRequirement(r.id, { verification_method: e.target.value })}
                    style={{ padding: 4, border: "1px solid var(--line)", borderRadius: 6 }}>
                    {["measurement", "demonstration", "inspection", "analysis"].map((v) => <option key={v}>{v}</option>)}
                  </select>
                  <button className="btn sm" onClick={() => setEditing(null)}>完成</button>
                </span>
              </span>
            ) : (
              <span style={{ flex: 1 }}>
                {r.description}
                {r.target != null && <span className="hint">（{r.target}{r.unit || ""}{r.tolerance ? ` ${r.tolerance}` : ""}）</span>}
                {r.source && <><br /><span className="hint">📎 {r.source}</span></>}
              </span>
            )}
            <span style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
              <span className={cls}>{label}</span>
              {r.priority === "mandatory" && <span className="must">基本</span>}
              {!isEdit && <button className="btn ghost sm" onClick={() => setEditing(r.id)}>改</button>}
              {r.status !== "CONFIRMED" && <button className="btn sm ok" onClick={() => ctx.setReqStatus(r.id, "CONFIRMED")}>✓</button>}
              {r.status !== "REJECTED" && <button className="btn ghost sm" onClick={() => ctx.setReqStatus(r.id, "REJECTED")}>✕</button>}
            </span>
          </div>
        );
      })}
      {ctx.requirements.ambiguities?.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {ctx.requirements.ambiguities.map((a: any, i: number) => (
            <div key={i} className="issue warning">❓ 题面歧义：{typeof a === "string" ? a : (a.description || a.text || JSON.stringify(a)) + (a.source ? `（出自：${a.source}）` : "")}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============ 方案块清单：替换模块 + 需求覆盖矩阵 ============ */
function BlockList({ sol, ctx }: { sol: any; ctx: any }) {
  const [replacing, setReplacing] = useState<any>(null);   // block
  const [q, setQ] = useState("");
  const [showMatrix, setShowMatrix] = useState(false);
  const reqs = (ctx.requirements?.requirements || []).filter((r: any) => r.status !== "REJECTED");
  const otherSol = (ctx.solutions?.solutions || ctx.solutions?.candidate_solutions || []).find((x: any) => x.solution_id !== sol.solution_id);

  const candidates = replacing ? [
    // 其他方案中同角色的模块置顶（支持从备选方案合并取用）
    ...(otherSol?.blocks || [])
      .filter((b: any) => b.role === replacing.role && b.module_id && b.module_id !== replacing.module_id)
      .map((b: any) => ({ ...(ctx.modules.find((m: any) => m.id === b.module_id) || { id: b.module_id, name: b.name }), _from: otherSol.solution_id })),
    ...ctx.modules.filter((m: any) =>
      m.id !== replacing.module_id &&
      (!q || `${m.name} ${m.main_chip} ${m.id}`.toLowerCase().includes(q.toLowerCase()))),
  ].filter((m: any, i: number, arr: any[]) => arr.findIndex((x) => x.id === m.id) === i).slice(0, 30) : [];

  return (
    <>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "4px 0" }}>
        {(sol.blocks || []).map((b: any) => (
          <span key={b.block_id} className="chip" style={{ display: "inline-flex", gap: 5, alignItems: "center", padding: "3px 6px 3px 10px" }}>
            {b.name}
            <button style={{ border: 0, background: "#fff", borderRadius: 5, padding: "0 6px", cursor: "pointer", fontSize: 11 }}
              onClick={() => { setReplacing(b); setQ(""); }}>替换</button>
          </span>
        ))}
        <button className="btn ghost sm" onClick={() => setShowMatrix(!showMatrix)}>{showMatrix ? "收起" : "需求覆盖矩阵"}</button>
      </div>

      {showMatrix && (
        <table className="data" style={{ margin: "6px 0" }}>
          <thead><tr><th>需求</th>{(sol.blocks || []).map((b: any) => <th key={b.block_id} style={{ writingMode: undefined }}>{b.name}</th>)}<th>覆盖</th></tr></thead>
          <tbody>
            {reqs.map((r: any) => {
              const hit = (sol.blocks || []).filter((b: any) => (b.covers_requirements || []).includes(r.id));
              return (
                <tr key={r.id} style={!hit.length ? { background: "#fdecec" } : undefined}>
                  <td><b>{r.id}</b> <span className="hint">{r.description.slice(0, 20)}</span></td>
                  {(sol.blocks || []).map((b: any) => (
                    <td key={b.block_id} style={{ textAlign: "center" }}>{(b.covers_requirements || []).includes(r.id) ? "✓" : ""}</td>
                  ))}
                  <td>{hit.length ? <span className="chip green">✓</span> : <span className="chip red">未覆盖</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {replacing && (
        <div className="modal-mask" onClick={() => setReplacing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>替换「{replacing.name}」</h3>
            <p className="hint">选择替换模块后自动重跑接口规则检查。来自其他备选方案的同角色模块排在最前，方便合并取用。</p>
            <input placeholder="搜索模块 / 芯片…" value={q} onChange={(e) => setQ(e.target.value)}
              style={{ width: "100%", padding: 8, border: "1px solid var(--line)", borderRadius: 8, margin: "8px 0" }} />
            {candidates.map((m: any) => (
              <div key={m.id} className="req-item" style={{ alignItems: "center" }}>
                <span style={{ flex: 1 }}>
                  <b>{m.name}</b> {m._from && <span className="chip violet">来自 {m._from}</span>}
                  <br /><span className="hint">{m.main_chip || m.id}</span>
                </span>
                <button className="btn sm" disabled={ctx.busy}
                  onClick={async () => { setReplacing(null); await ctx.replaceBlock(sol.solution_id, replacing.block_id, m); }}>选用</button>
              </div>
            ))}
            <div style={{ textAlign: "right", marginTop: 10 }}>
              <button className="btn ghost sm" onClick={() => setReplacing(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}


/* ============ 赛题选择器：历年赛题 / PDF 上传 / 粘贴文本 ============ */
function ProblemPicker({ ctx }: { ctx: any }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [official, setOfficial] = useState<any[]>([]);

  // 官方已发布题目：采用后直接得到结构化需求，零模型调用
  const [facets, setFacets] = useState<any>(null);
  const [filter, setFilter] = useState<{ year?: string; contest?: string; tech?: string; q?: string }>({});
  const SHOW_LIMIT = 40;
  const hasFilter = !!(filter.contest || filter.year || filter.tech || (filter.q && filter.q.length >= 1));
  const shown = official.slice(0, SHOW_LIMIT);

  useEffect(() => {
    // 选题只列可直接采用的题目：未发布的点了会 409，
    // 管理员登录时接口默认会带出草稿，这里显式排除
    const qs = new URLSearchParams({ facets: "1", published_only: "1" });
    for (const [k, v] of Object.entries(filter)) if (v) qs.set(k === "q" ? "q" : k, v);
    fetch(`/api/problems?${qs}`)
      .then((r) => r.json())
      .then((d) => { setOfficial(d.problems || []); if (d.facets) setFacets(d.facets); })
      .catch(() => {});
  }, [filter]);

  async function adoptOfficial(problemId: string) {
    setBusy(true); setMsg("正在载入官方题目…");
    const pid = await ctx.ensureProjectForProblem?.();
    const r = await fetch(`/api/projects/${pid}/adopt-problem`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ problem_id: problemId }),
    }).then((x) => x.json()).catch(() => null);
    setBusy(false);
    if (r?.ok) {
      setMsg(`已载入官方题目：${r.requirements} 条需求、${r.scoring_items} 个评分项（未消耗模型调用）`);
      ctx.reloadProject?.(pid);
    } else {
      // 最常见的原因是题目尚未发布（工作人员还没提取需求并复核）
      const e = String(r?.error || "");
      setMsg(/未发布|尚未/.test(e)
        ? `${e}。该题已在题库但还没完成解析与复核，暂时无法一键载入 —— ` +
          `可以先把题面粘贴到下方对话框，或改选已发布的题目。`
        : e || "载入失败，请重试或改用粘贴题面的方式。");
    }
  }

  async function onPdf(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { setMsg("PDF 超过 8MB，请压缩后再传"); return; }
    setBusy(true); setMsg(`正在解析 ${f.name}…`);
    const b64: string = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1]);
      r.onerror = () => rej(new Error("读取失败"));
      r.readAsDataURL(f);
    });
    const r = await fetch("/api/extract-pdf", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data_base64: b64 }) }).then((x) => x.json());
    setBusy(false);
    if (r.text) {
      setMsg(`已提取 ${r.chars} 字，正在解析需求…`);
      ctx.runInterpret(r.text);
    } else setMsg(r.error || "解析失败，请改用粘贴文本");
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <h3>选择赛题</h3>
      {/* 官方题库选择。245 道题全铺开会把页面撑爆，
          因此默认只显示筛选器，选定条件或搜索后才列出匹配项。 */}
      <div className="card" style={{ padding: 12, marginBottom: 10 }}>
        <p className="hint" style={{ margin: "0 0 8px" }}>
          ✅ 官方标准题目（已由工作人员解析并复核，选用后直接得到结构化需求与评分项，无需等待 AI 解析）
        </p>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <select value={filter.contest || ""} onChange={(e) => setFilter({ ...filter, contest: e.target.value })}
            style={{ padding: "6px 9px", border: "1px solid var(--line)", borderRadius: 7, fontSize: 13 }}>
            <option value="">全部赛事</option>
            {facets?.contestTypes?.map((c: any) => (
              <option key={c.value} value={c.value}>{CONTEST_CN[c.value] || c.value}（{c.count}）</option>
            ))}
          </select>

          <select value={filter.year || ""} onChange={(e) => setFilter({ ...filter, year: e.target.value })}
            style={{ padding: "6px 9px", border: "1px solid var(--line)", borderRadius: 7, fontSize: 13 }}>
            <option value="">全部年份</option>
            {facets?.years?.map((y: any) => <option key={y.value} value={y.value}>{y.value} 年（{y.count}）</option>)}
          </select>

          <select value={filter.tech || ""} onChange={(e) => setFilter({ ...filter, tech: e.target.value })}
            style={{ padding: "6px 9px", border: "1px solid var(--line)", borderRadius: 7, fontSize: 13 }}>
            <option value="">全部方向</option>
            {facets?.tech?.map((t: any) => (
              <option key={t.value} value={t.value}>{TECH_CN[t.value] || t.value}（{t.count}）</option>
            ))}
          </select>

          <input value={filter.q || ""} onChange={(e) => setFilter({ ...filter, q: e.target.value })}
            placeholder="搜索题目名称"
            style={{ padding: "6px 9px", border: "1px solid var(--line)", borderRadius: 7, fontSize: 13, width: 170 }} />

          {hasFilter && <button className="btn ghost sm" onClick={() => setFilter({})}>清除</button>}

          <span style={{ flex: 1 }} />
          <label className="btn ghost sm" style={{ display: "inline-block" }}>
            📄 上传赛题 PDF
            <input type="file" accept="application/pdf" hidden onChange={onPdf} disabled={busy} />
          </label>
          {busy && <span className="spinner" />}
        </div>

        {!hasFilter ? (
          <p className="hint" style={{ margin: "10px 0 0" }}>
            题库共 {official.length} 道题。请用上方条件筛选，或直接搜索题目名称；
            也可以跳过选题，把题面粘贴到下方对话框。
          </p>
        ) : (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
            {shown.map((p: any) => (
              <button key={p.problem_id} className="btn ghost sm" disabled={busy}
                title={`${CONTEST_CN[p.contest_type] || ""} · ${(p.tech_tags || []).map((t: string) => TECH_CN[t] || t).join("/")}`}
                onClick={() => adoptOfficial(p.problem_id)}>
                {p.year} {p.code} · {p.title}
                {p.requirement_count > 0 && <span className="hint"> · {p.requirement_count} 条需求</span>}
              </button>
            ))}
            {!official.length && (
              <span className="hint">
                没有匹配的<b>已发布</b>题目。题库里的题目需在后台完成解析、确认与发布后才能选用。
              </span>
            )}
            {official.length > SHOW_LIMIT && (
              <span className="hint" style={{ alignSelf: "center" }}>
                共 {official.length} 条，仅显示前 {SHOW_LIMIT} 条，请继续缩小范围
              </span>
            )}
          </div>
        )}
      </div>

      {msg && <p className="hint" style={{ marginTop: 8 }}>{msg}</p>}
      <p className="hint" style={{ marginTop: 8 }}>💡 电赛题目下发即为 PDF，直接上传最省事；也可直接把题面粘贴到下方对话框。</p>
    </div>
  );
}


/* ============ 框图功能块说明弹窗 ============ */
function BlockInfoModal({ item, onClose }: { item: any; onClose: () => void }) {
  const isModule = !item._fallback;
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{item.name}</h3>
        {isModule ? (
          <>
            <p className="hint">{item.main_chip} · {item.category}</p>
            {(item.images || []).length > 0 && (
              <div className="module-gallery">
                {(item.images || []).slice(0, 3).map((src: string, i: number) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={i} src={src} alt={`${item.name} 图 ${i + 1}`} loading="lazy"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                ))}
              </div>
            )}
            <p>{item.description}</p>
            {item.interfaces?.length > 0 && (
              <>
                <h4>接口</h4>
                <table className="data">
                  <thead><tr><th>接口</th><th>类型</th><th>电平</th></tr></thead>
                  <tbody>
                    {item.interfaces.map((i: any, k: number) => (
                      <tr key={k}><td>{i.name}</td><td>{i.interface_type}</td>
                        <td>{i.voltage_level}V{i.five_v_tolerant ? "（5V 容忍）" : ""}</td></tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            <h4>电气</h4>
            <p className="hint">
              供电 {item.power?.input_voltage_range?.join("~") || "—"}V ·
              典型 {item.power?.typical_current_ma ?? "—"}mA
              {item.power?.peak_current_ma ? ` · 峰值 ${item.power.peak_current_ma}mA` : ""}
            </p>
            {item.usage_notes?.length > 0 && (<><h4>使用要点</h4><ul>{item.usage_notes.map((n: string) => <li key={n}>{n}</li>)}</ul></>)}
            {item.known_issues?.length > 0 && (<><h4>已知坑点</h4>{item.known_issues.map((n: string) => <div key={n} className="issue warning">⚠ {n}</div>)}</>)}
          </>
        ) : (
          <>
            <p className="hint">功能块 {item.block_id}{item.role ? ` · 角色 ${item.role}` : ""}</p>
            <div className="issue info" style={{ display: "block" }}>
              该功能块未绑定模块库中的具体模块{item.module_id ? `（引用的 ${item.module_id} 不在库中）` : ""}。
              <br />可在方案卡片下方点该功能块的「替换」选一个真实模块，规则引擎才能对它做电平与电源校验。
            </div>
            {item.covers_requirements?.length > 0 && (
              <><h4>覆盖需求</h4><p className="hint">{item.covers_requirements.join("、")}</p></>
            )}
          </>
        )}
        <div style={{ textAlign: "right", marginTop: 12 }}>
          <button className="btn ghost sm" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
