"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { TYPICAL_DIRECTIONS, FEATURES, COMPETITION_DATE, COMPETITION_NAME } from "../data/prep-content";
import { CATEGORY_TREE, CAT_ICON, categoryLabel } from "../data/categories";
import { STAGES, STAGE_LABEL } from "./Platform";

const CERT_LABEL: Record<string, [string, string]> = {
  DRAFT: ["待审核", "chip"], DOCUMENTED: ["已建档", "chip"], POWER_TESTED: ["电测通过", "chip"],
  FUNCTION_TESTED: ["功能实测", "chip green"], BENCHMARKED: ["已标定", "chip green"],
  COMPETITION_READY: ["赛用认证", "chip gold"], DEPRECATED: ["已弃用", "chip red"],
};
export function CertBadge({ s }: { s: string }) {
  const [label, cls] = CERT_LABEL[s] || [s, "chip"];
  return <span className={cls}>{label}</span>;
}
function modIcon(cat: string) { return CAT_ICON[String(cat).split(".")[0]] || "🔲"; }

/** 模块缩略图：录入了 images 就显示实拍图，否则回退到分类图标。
 *  方形容器 + object-fit:contain，保证不同比例的商品图都能完整显示不变形。 */
export function ModuleThumb({ m, size }: { m: any; size?: number }) {
  const src = (m?.images || [])[0];
  const style = size ? { width: size, height: size, flexShrink: 0 } : undefined;
  if (!src) return <div className="thumb" style={style}>{modIcon(m?.category)}</div>;
  return (
    <div className="thumb has-img" style={style}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={m?.name || "模块图片"} loading="lazy"
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
    </div>
  );
}

/* ================= 首页 ================= */
export function HomePage({ ctx }: { ctx: any }) {
  const [detail, setDetail] = useState<any>(null);
  const hot = useMemo(
    () => [...ctx.modules].sort((a, b) => (b.downloads || 0) - (a.downloads || 0) || (b.price || 0) - (a.price || 0)).slice(0, 5),
    [ctx.modules]
  );
  return (
    <>
      <div className="hero">
        <div className="kicker">智能 · 高效 · 严谨</div>
        <h2>电赛智能体 你的全能备赛伙伴</h2>
        <div className="feats">
          <span>结构化模块库</span><span>AI 方案生成 + 规则接口检查</span>
          <span>代码与调试支持</span><span>报告一键成稿</span>
        </div>
        <div className="chiptags">
          <i>DDS</i><i>ADC / DAC</i><i>视觉 / K230</i><i>电源管理</i><i>电机驱动</i>
        </div>
      </div>

      <div className="grid cols-5 feature-cards" style={{ marginBottom: 16 }}>
        {FEATURES.map((f) => (
          <button key={f.key} className="fcard" onClick={() => ctx.setPage(f.key)}>
            <span className="fi" style={{ background: f.color }}>{f.icon}</span>
            <b>{f.name}</b><small>{f.desc}</small>
          </button>
        ))}
      </div>

      <Dashboard ctx={ctx} />
      <AccountCard />

      <div className="grid" style={{ gridTemplateColumns: "1fr", alignItems: "start" }}>
        <div style={{ display: "grid", gap: 14 }}>
          <div className="card">
            <h3>热门模块推荐 <span className="more" onClick={() => ctx.setPage("modules")}>更多模块 →</span></h3>
            <div className="grid cols-5">
              {hot.map((m) => (
                <button key={m.id} className="mod-card as-button" onClick={() => setDetail(m)}
                  title={`查看 ${m.name} 详情`}>
                  <ModuleThumb m={m} />
                  <div>
                    <CertBadge s={m.certification_status} />
                    {(m.tags || []).slice(0, 1).map((t: string) => <span key={t} className="chip">{t}</span>)}
                  </div>
                  <b>{m.name}</b>
                  <span className="hint">{m.main_chip}</span>
                </button>
              ))}
              {!hot.length && <span className="hint">模块库为空 —— 运行 npm run db:seed 导入种子模块。</span>}
            </div>
          </div>

          <div className="card">
            <h3>典型应用方向 <span className="hint" style={{ fontWeight: 400 }}>点击即用该方向示例开始方案设计</span></h3>
            <div className="grid cols-5">
              {TYPICAL_DIRECTIONS.map((d) => (
                <button key={d.name} className="fcard" onClick={() => ctx.startFromDirection(d.seed)}>
                  <span className="fi" style={{ background: "#eef3fd", color: "#1d4ed8", fontSize: 22 }}>{d.icon}</span>
                  <b>{d.name}</b>
                  <small>{d.tags.join(" / ")}</small>
                </button>
              ))}
            </div>
          </div>
        </div>

      </div>

      {detail && <ModuleDetailModal detail={detail} onClose={() => setDetail(null)}
        onPick={() => { ctx.setShortlist((s: string[]) => s.includes(detail.id) ? s : [...s, detail.id]); setDetail(null); }}
        picked={ctx.shortlist?.includes(detail.id)} />}

      <div className="statsbar">
        <span><b>{ctx.modules.length}</b> 个结构化模块</span>
        <span><b>11</b> 个专业 Agent</span>
        <span><b>3</b> 套确定性规则引擎</span>
        <span><b>7</b> 级模块认证状态机</span>
        <span style={{ marginLeft: "auto" }}>🔄 模块库持续更新中</span>
      </div>
    </>
  );
}

/* ================= 模块选型 ================= */
export function ModulesPage({ ctx }: { ctx: any }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [detail, setDetail] = useState<any>(null);
  const list = useMemo(() => ctx.modules.filter((m: any) => {
    if (cat && !String(m.category).startsWith(cat)) return false;
    if (q) {
      const hay = `${m.name} ${m.main_chip} ${m.description} ${(m.tags || []).join(" ")}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  }), [ctx.modules, q, cat]);

  return (
    <>
      <div className="card" style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <b style={{ fontSize: 14 }}>模块库 · 选型</b>
          <p className="hint" style={{ margin: "3px 0 0" }}>
            这里是<b>可选步骤</b>：浏览模块资料、查接口与坑点。点「选用」把手头有的模块加入优先清单，
            生成方案时会优先考虑它们；不选也能正常生成方案。
          </p>
        </div>
        {ctx.shortlist.length > 0 && (
          <>
            <span className="chip green">已选用 {ctx.shortlist.length} 个</span>
            <button className="btn ghost sm" onClick={() => ctx.setShortlist([])}>清空</button>
          </>
        )}
        <button className="btn sm" onClick={() => ctx.setPage("solution")}>
          {ctx.shortlist.length ? "带着选用模块去生成方案 →" : "去方案生成 →"}
        </button>
      </div>

      <div className="filterbar">
        <input placeholder="搜索模块 / 型号 / 功能 / 芯片…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={"fchip" + (cat === "" ? " on" : "")} onClick={() => setCat("")}>全部</button>
        {CATEGORY_TREE.map((c) => (
          <button key={c.key} className={"fchip" + (cat === c.key ? " on" : "")} onClick={() => setCat(c.key)}>{c.icon} {c.label}</button>
        ))}
      </div>

      <div className="grid cols-3">
        {list.map((m: any) => {
          const picked = ctx.shortlist.includes(m.id);
          return (
            <div key={m.id} className="card mod-card">
              <div style={{ display: "flex", gap: 12 }}>
                <ModuleThumb m={m} size={84} />
                <div style={{ minWidth: 0 }}>
                  <b>{m.name}</b>
                  <div className="hint">{m.main_chip} · {m.description?.slice(0, 34)}…</div>
                  <div style={{ marginTop: 4 }}>
                    <CertBadge s={m.certification_status} />
                    {(m.tags || []).slice(0, 2).map((t: string) => <span key={t} className="chip">{t}</span>)}
                    {m.assets_locked && <span className="chip violet">🔒 资料需付费</span>}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                <span className="price">¥{m.price}</span>
                <span className="hint">{m.source_snapshot?.source === "taobao" ? "淘宝快照" : m.source_snapshot?.source === "lab" ? "实验室" : "官方"}</span>
                <span style={{ flex: 1 }} />
                <button className="btn ghost sm" onClick={() => setDetail(m)}>详情</button>
                <button className={"btn sm" + (picked ? " ok" : "")}
                  onClick={() => ctx.setShortlist((s: string[]) => picked ? s.filter((x) => x !== m.id) : [...s, m.id])}>
                  {picked ? "✓ 已选用" : "选用"}
                </button>
              </div>
            </div>
          );
        })}
        {!list.length && <p className="hint">没有匹配的模块。</p>}
      </div>

      {detail && <ModuleDetailModal detail={detail} onClose={() => setDetail(null)}
        onPick={() => { ctx.setShortlist((sl: string[]) => sl.includes(detail.id) ? sl : [...sl, detail.id]); setDetail(null); }}
        picked={ctx.shortlist?.includes(detail.id)} />}
    </>
  );
}

/* ================= 模块详情弹窗（首页与模块选型共用） ================= */
export function ModuleDetailModal({ detail, onClose, onPick, picked }: { detail: any; onClose: () => void; onPick?: () => void; picked?: boolean }) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{detail.name} <CertBadge s={detail.certification_status} />
          {detail._completeness != null && <span className="chip">数据完整度 {detail._completeness}%</span>}</h3>
        <p className="hint">{categoryLabel(detail.category)} · {detail.main_chip}</p>
        {(detail.images || []).length > 0 && (
          <div className="module-gallery">
            {(detail.images || []).slice(0, 4).map((src: string, i: number) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={src} alt={`${detail.name} 图 ${i + 1}`} loading="lazy"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
            ))}
          </div>
        )}
        <p>{detail.description}</p>
        <h4>接口定义</h4>
        <table className="data"><thead><tr><th>接口</th><th>类型</th><th>电平</th><th>约束</th></tr></thead>
          <tbody>
            {(detail.interfaces || []).map((it: any, i: number) => (
              <tr key={i}>
                <td>{it.name}</td><td>{it.interface_type}</td>
                <td>{it.voltage_level}V{it.five_v_tolerant ? "（5V 容忍）" : ""}</td>
                <td>{(it.constraints || []).join("；") || "—"}</td>
              </tr>
            ))}
            {!detail.interfaces?.length && <tr><td colSpan={4} className="hint">未录入接口 —— 规则引擎无法对其做电平检查</td></tr>}
          </tbody>
        </table>
        <h4>电气参数</h4>
        <p className="hint">供电 {detail.power?.input_voltage_range?.join("~") || "—"}V · 典型电流 {detail.power?.typical_current_ma ?? "—"}mA{detail.power?.peak_current_ma ? ` · 峰值 ${detail.power.peak_current_ma}mA` : ""}</p>
        {detail.usage_notes?.length > 0 && (<><h4>使用要点</h4><ul>{detail.usage_notes.map((n: string) => <li key={n}>{n}</li>)}</ul></>)}
        {detail.known_issues?.length > 0 && (<><h4>已知坑点</h4>{detail.known_issues.map((n: string) => <div key={n} className="issue warning">⚠ {n}</div>)}</>)}
        {detail.competition_cases?.length > 0 && (<><h4>历届应用</h4><p className="hint">{detail.competition_cases.map((c: any) => `${c.year} ${c.problem}（${c.note || ""}）`).join("；")}</p></>)}
        {detail.evidence_records?.length > 0 && (
          <><h4>参数证据</h4><table className="data"><thead><tr><th>参数</th><th>实测</th><th>等级</th><th>条件</th></tr></thead>
            <tbody>{detail.evidence_records.map((e: any, i: number) => (
              <tr key={i}><td>{e.param}</td><td>{e.value}{e.unit || ""}</td>
                <td><span className={"chip " + (["E5", "E6"].includes(e.evidence_level) ? "green" : "gold")}>{e.evidence_level}</span></td>
                <td className="hint">{e.conditions || "—"}</td></tr>))}
            </tbody></table></>
        )}
        {detail.assets_locked
          ? <div className="issue info">🔒 原理图 / PCB / 代码仓库为付费资料，且仅开放「功能实测」及以上认证等级的模块。</div>
          : detail.schematic_assets?.length > 0 && <p className="hint">含原理图等完整资料 {detail.schematic_assets.length} 份。</p>}
        <div style={{ textAlign: "right", marginTop: 12, display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn ghost sm" onClick={onClose}>关闭</button>
          {onPick && <button className={"btn sm" + (picked ? " ok" : "")} onClick={onPick}>{picked ? "✓ 已选用" : "选用到方案"}</button>}
        </div>
      </div>
    </div>
  );
}

/* ================= 我的项目 ================= */
function ArtifactHistory({ projectId, onRestored }: { projectId: string; onRestored: () => void }) {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    fetch(`/api/projects/${projectId}`).then((r) => r.json()).then((d) => setRows(d.artifacts || []));
  }, [projectId]);
  const TYPE_CN: Record<string, string> = {
    requirements: "需求", solution_proposal: "候选方案", solution: "确认方案", bom: "BOM",
    integration_report: "接口检查", code_bundle: "代码", code_verification: "代码验证",
    test_plan: "测试计划", test_record: "实测记录", score: "得分", test_report: "测试汇总", report: "报告",
  };
  async function restore(a: any) {
    const r = await fetch(`/api/projects/${projectId}/artifacts/${a.artifact_id}/restore`, { method: "POST" }).then((x) => x.json());
    if (r.version) { onRestored(); }
  }
  return (
    <table className="data" style={{ marginTop: 8 }}>
      <thead><tr><th>产物</th><th>版本</th><th>状态</th><th>来源</th><th>时间</th><th></th></tr></thead>
      <tbody>
        {rows.slice(0, 30).map((a) => (
          <tr key={a.artifact_id}>
            <td>{TYPE_CN[a.type] || a.type}</td><td>v{a.version}</td>
            <td>{a.status === "stale" ? <span className="chip gold">已过期</span> : a.status}</td>
            <td className="hint">{a.created_by}</td>
            <td className="hint">{String(a.created_at).slice(5, 16).replace("T", " ")}</td>
            <td><button className="btn ghost sm" onClick={() => restore(a)}>恢复为最新</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SnapshotBar({ projectId }: { projectId: string }) {
  const [snaps, setSnaps] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const load = useCallback(() => fetch(`/api/projects/${projectId}/snapshots`).then((r) => r.json()).then((d) => setSnaps(d.snapshots || [])), [projectId]);
  useEffect(() => { load(); }, [load]);
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn ghost sm" onClick={async () => {
          const r = await fetch(`/api/projects/${projectId}/snapshots`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((x) => x.json());
          setMsg(r.snapshot_id ? `已创建快照（${r.types.length} 类产物）` : r.error); load();
        }}>📸 创建快照</button>
        {snaps.map((s) => (
          <span key={s.snapshot_id} className="chip" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            {s.name}
            <button style={{ border: 0, background: "#fff", borderRadius: 5, padding: "0 6px", cursor: "pointer", fontSize: 11 }}
              onClick={async () => {
                const r = await fetch(`/api/projects/${projectId}/snapshots/${s.snapshot_id}/restore`, { method: "POST" }).then((x) => x.json());
                setMsg(r.restored ? `已整套恢复 ${Object.keys(r.restored).length} 类产物到该时点` : r.error);
              }}>恢复整套</button>
          </span>
        ))}
      </div>
      {msg && <p className="hint" style={{ margin: "4px 0 0" }}>{msg}</p>}
    </div>
  );
}

export function ProjectsPage({ ctx }: { ctx: any }) {
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [noting, setNoting] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  async function patchProject(id: string, body: any) {
    await fetch(`/api/projects/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    ctx.reloadProjects?.();
  }
  async function saveName(id: string, name: string) {
    setEditing(null);
    if (name.trim()) await patchProject(id, { name: name.trim() });
  }
  async function saveNote(id: string, note: string) {
    setNoting(null);
    await patchProject(id, { note });
  }
  async function toggleArchive(p: any) {
    await patchProject(p.project_id, { archived: p.archived === 1 ? 0 : 1 });
  }
  async function remove(p: any) {
    if (!confirm(`确定删除「${p.name}」？\n\n项目的所有产物、快照、任务与编译记录都会一并删除，无法恢复。`)) return;
    await fetch(`/api/projects/${p.project_id}`, { method: "DELETE" });
    if (ctx.projectId === p.project_id) ctx.setProjectId(null);
    ctx.reloadProjects?.();
  }
  return (
    <div className="grid cols-2">
      {ctx.projects.map((p: any) => {
        const idx = STAGES.indexOf(p.stage);
        return (
          <div key={p.project_id} className="card">
            <h3 style={{ flexWrap: "wrap" }}>
              {editing === p.project_id ? (
                <input autoFocus defaultValue={p.name} style={{ flex: 1, padding: 5, border: "1px solid var(--line)", borderRadius: 6, font: "inherit" }}
                  onKeyDown={(e) => { if (e.key === "Enter") saveName(p.project_id, (e.target as HTMLInputElement).value); if (e.key === "Escape") setEditing(null); }}
                  onBlur={(e) => saveName(p.project_id, e.target.value)} />
              ) : (
                <>
                  {p.name}
                  {p.archived === 1 && <span className="chip" style={{ marginLeft: 6 }}>已归档</span>}
                </>
              )}
              <span className="more" onClick={() => setEditing(p.project_id)}>重命名</span>
              <span className="more" onClick={() => setNoting(noting === p.project_id ? null : p.project_id)}>标注</span>
              <span className="more" onClick={() => setHistoryOf(historyOf === p.project_id ? null : p.project_id)}>{historyOf === p.project_id ? "收起历史" : "版本历史"}</span>
              <span className="more" onClick={() => { ctx.setProjectId(p.project_id); ctx.setPage("solution"); }}>打开 →</span>
            </h3>
            {p.note && noting !== p.project_id && <p className="hint" style={{ margin: "2px 0 6px" }}>📝 {p.note}</p>}
            {noting === p.project_id && (
              <div style={{ display: "flex", gap: 6, margin: "4px 0 8px" }}>
                <input defaultValue={p.note || ""} placeholder="给这个项目加个标注，如「2023-A 运放测量 · 主力方案」"
                  style={{ flex: 1, padding: 6, border: "1px solid var(--line)", borderRadius: 6 }}
                  onKeyDown={(e) => { if (e.key === "Enter") saveNote(p.project_id, (e.target as HTMLInputElement).value); }}
                  onBlur={(e) => saveNote(p.project_id, e.target.value)} />
              </div>
            )}
            <SnapshotBar projectId={p.project_id} />
            <div style={{ display: "flex", gap: 8, marginTop: 8, justifyContent: "flex-end" }}>
              <button className="btn ghost sm" onClick={() => toggleArchive(p)}>{p.archived === 1 ? "取消归档" : "归档"}</button>
              <button className="btn ghost sm danger" onClick={() => remove(p)}>删除</button>
            </div>
            {historyOf === p.project_id && <ArtifactHistory projectId={p.project_id} onRestored={() => { if (ctx.projectId === p.project_id) ctx.setProjectId(p.project_id); }} />}
          </div>
        );
      })}
      {!ctx.projects.length && <p className="hint">还没有项目 —— 到「方案生成」页粘贴赛题即会自动创建。</p>}
    </div>
  );
}


/* ============ 项目驾驶舱 + 比赛倒计时 ============ */
function Dashboard({ ctx }: { ctx: any }) {
  const days = Math.ceil((new Date(COMPETITION_DATE).getTime() - Date.now()) / 86400000);
  const reqs: any[] = (ctx.requirements?.requirements || []).filter((r: any) => r.status !== "REJECTED");
  const mand = reqs.filter((r: any) => r.priority === "mandatory");
  const confirmed = mand.filter((r: any) => r.status === "CONFIRMED").length;
  const sum = ctx.testResult?.summary;
  const hasProject = !!ctx.projectId;
  return (
    <div className="statsbar" style={{ marginBottom: 16 }}>
      <span>⏱ {COMPETITION_NAME} {days > 0 ? <>还有 <b style={{ fontSize: 18 }}>{days}</b> 天</> : days > -5 ? <b style={{ color: "var(--red)" }}>比赛进行中</b> : <b>已结束</b>}</span>
      {hasProject ? (
        <>
          <span>阶段 <b>{STAGE_LABEL[ctx.stage] || ctx.stage}</b></span>
          {mand.length > 0 && <span>需求确认 <b style={{ color: confirmed === mand.length ? "var(--ok)" : "var(--amber)" }}>{confirmed}/{mand.length}</b></span>}
          {ctx.chosenSolution && <span>主方案 <b>{ctx.chosenSolution.solution_id}</b>{ctx.backupSolution && <span className="chip violet" style={{ marginLeft: 4 }}>备 {ctx.backupSolution.solution_id}</span>}</span>}
          {sum && <span>基本要求 <b style={{ color: sum.blockers.length ? "var(--red)" : "var(--ok)" }}>{sum.mandatory_passed}/{sum.mandatory_total}</b> · 预计 <b>{sum.score_low}~{sum.score_high}</b> 分</span>}
          {sum?.blockers?.length > 0 && <span className="chip red">阻断 {sum.blockers.length}：{sum.blockers[0].slice(0, 16)}…</span>}
        </>
      ) : (
        <span className="hint">还没有进行中的项目 —— 到「方案生成」粘贴赛题开始</span>
      )}
    </div>
  );
}


/* ============ 账户与套餐 ============ */
export function AccountCard() {
  const [acc, setAcc] = useState<any>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");
  const load = useCallback(() => { fetch("/api/account").then((r) => r.json()).then(setAcc).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  if (!acc) return null;

  const TIER_CN: Record<string, string> = { free: "免费", paid: "付费", lab: "实验室", admin: "管理员" };
  const caps = acc.capabilities || {};
  async function redeem() {
    setMsg("");
    const r = await fetch("/api/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ access_code: code }) }).then((x) => x.json());
    if (r.ok) { setMsg("已升级为付费账户 ✓"); setCode(""); load(); }
    else setMsg(r.error || "升级失败");
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3>账户 <span className={"chip " + (acc.tier === "free" ? "" : "green")}>{TIER_CN[acc.tier] || acc.tier}</span></h3>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "6px 0" }}>
        {[["代码生成", caps.code_generation], ["报告生成", caps.report_generation], ["调试助手", caps.debug_assistant],
          ["资料下载", caps.asset_download], ["模块上传", caps.module_upload]].map(([label, on]) => (
          <span key={String(label)} className={"chip " + (on ? "green" : "")}>{on ? "✓" : "🔒"} {label}</span>
        ))}
      </div>
      {acc.usage_today && Object.keys(acc.usage_today).length > 0 && (
        <p className="hint">今日用量：{Object.entries(acc.usage_today).map(([k, v]) => `${k} ${v} 次`).join(" · ")}</p>
      )}
      {acc.tier === "free" && (
        acc.upgrade_available ? (
          <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="输入兑换码升级为付费账户"
              style={{ flex: 1, minWidth: 200, padding: 7, border: "1px solid var(--line)", borderRadius: 8 }} />
            <button className="btn sm" onClick={redeem} disabled={!code.trim()}>升级</button>
          </div>
        ) : (
          <div className="issue info" style={{ display: "block", marginTop: 8 }}>
            代码生成、报告生成、调试助手为付费能力。独立部署时，在 Vercel 环境变量中设置 <code>PAID_ACCESS_CODE</code> 后，
            此处会出现兑换码入口；接入 ezPLM 后由 ezPLM 统一下发账户等级。
          </div>
        )
      )}
      {msg && <p className="hint" style={{ marginTop: 6 }}>{msg}</p>}
    </div>
  );
}
