"use client";
import { useCallback, useEffect, useState } from "react";

/** 赛题中心（工作人员）：上传 PDF → 双模复核提取 → 差异确认 → 发布标准题目。
 *  发布后用户项目直接引用，不再重复调用模型。 */
export default function ProblemCenterClient() {
  const [list, setList] = useState<any[]>([]);
  const [authed, setAuthed] = useState(false);
  const [key, setKey] = useState("");
  const [sel, setSel] = useState<any>(null);
  const [diffs, setDiffs] = useState<any[]>([]);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [taxonomyReady, setTaxonomyReady] = useState(true);
  const [form, setForm] = useState({ year: new Date().getFullYear(), code: "A", title: "", group_name: "本科组" });

  const load = useCallback(async () => {
    const d = await fetch("/api/problems?status=").then((r) => r.json()).catch(() => null);
    if (!d || d.error) { setAuthed(false); return; }
    setList(d.problems || []);
    setTaxonomyReady(d.taxonomy_ready !== false);
    setAuthed(true);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function login() {
    const r = await fetch("/api/admin/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
    if (r.ok) { setKey(""); load(); } else setMsg("密钥错误");
  }

  async function openProblem(id: string) {
    // 此前没有错误处理：接口报错时 d.problem 是 undefined，
    // setSel(undefined) 后界面毫无变化，表现为「点了没反应」
    setMsg("");
    setLoadingId(id);
    try {
      const res = await fetch(`/api/problems/${id}`);
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setMsg(`打开失败（HTTP ${res.status}）：${d?.error || "服务端未返回详情"}`);
        return;
      }
      if (!d?.problem) {
        setMsg("接口未返回题目内容。可能是该题尚无版本记录，或数据库结构与当前版本不一致。");
        return;
      }
      setSel(d.problem);

      const dd = await fetch(`/api/problems/${id}/diffs`).then((r) => r.json()).catch(() => ({ diffs: [] }));
      setDiffs(dd.diffs || []);
    } catch (e: any) {
      setMsg(`打开失败：${String(e?.message || e).slice(0, 160)}`);
    } finally {
      setLoadingId(null);
    }
  }

  async function create() {
    if (!form.title.trim()) { setMsg("请填写题目名称"); return; }
    const r = await fetch("/api/problems", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) }).then((x) => x.json());
    if (r.problem_id) { setMsg(r.existing ? "该题目已存在" : "已创建"); load(); openProblem(r.problem_id); }
    else setMsg(r.error || "创建失败");
  }

  async function uploadPdf(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f || !sel) return;
    setBusy("正在解析 PDF 并双模复核（约 1~3 分钟）…");
    const b64: string = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1]);
      r.onerror = () => rej(new Error("读取失败"));
      r.readAsDataURL(f);
    });
    const r = await fetch(`/api/problems/${sel.problem_id}/extract`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ data_base64: b64, dual_review: true }),
    }).then((x) => x.json()).catch(() => null);
    setBusy("");
    if (r?.ok) {
      setMsg(`提取完成：需求 ${r.requirements} 条、评分项 ${r.scoring_items ?? 0} 项` +
        (r.dual_review ? `，${r.provider_a} 与 ${r.provider_b} 复核发现 ${r.diffs} 处差异（${r.critical_diffs} 处关键）` : `（${r.warning || "未复核"}）`));
      openProblem(sel.problem_id);
    } else setMsg(r?.error || "提取失败");
  }

  async function extractFromText() {
    if (!sel) return;
    const text = prompt("粘贴赛题原文（也可直接上传 PDF）：");
    if (!text) return;
    setBusy("正在提取并复核…");
    const r = await fetch(`/api/problems/${sel.problem_id}/extract`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw_text: text, dual_review: true }),
    }).then((x) => x.json()).catch(() => null);
    setBusy("");
    if (r?.ok) { setMsg(`提取完成，${r.diffs ?? 0} 处差异待确认`); openProblem(sel.problem_id); }
    else setMsg(r?.error || "提取失败");
  }

  async function resolveDiff(id: number, resolution: string) {
    await fetch(`/api/problems/${sel.problem_id}/diffs`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ diff_id: id, resolution }),
    });
    openProblem(sel.problem_id);
  }

  async function publish() {
    const r = await fetch(`/api/problems/${sel.problem_id}/publish`, { method: "POST" }).then((x) => x.json());
    if (r.ok) { setMsg("已发布！用户现在可以直接选用该题目（零模型调用）"); load(); openProblem(sel.problem_id); }
    else setMsg(r.error);
  }

  if (!authed) {
    return (
      <div style={{ padding: 40 }}>
        <div className="card" style={{ maxWidth: 420, margin: "80px auto" }}>
          <h3>赛题中心</h3>
          <p className="hint">需要工作人员密钥</p>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") login(); }}
            style={{ width: "100%", padding: 9, border: "1px solid var(--line)", borderRadius: 8, margin: "8px 0" }} />
          <button className="btn" style={{ width: "100%" }} onClick={login}>登录</button>
          {msg && <p className="hint" style={{ color: "var(--red)" }}>{msg}</p>}
        </div>
      </div>
    );
  }

  const critical = diffs.filter((d) => d.severity === "critical" && !d.resolved).length;
  return (
    <div style={{ padding: "20px 28px", maxWidth: 1280, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 4px" }}>赛题中心</h2>
      <p className="hint">官方题目在此解析一次并发布；用户项目直接引用发布版本，不再消耗模型。</p>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) 380px", gap: 14, alignItems: "start", marginTop: 14 }}>
        <div style={{ display: "grid", gap: 14 }}>
          {sel ? (
            <>
              <div className="card">
                <h3>
                  {sel.year} 年 {sel.code} 题 · {sel.title}
                  <span className={"chip " + (sel.status === "published" ? "green" : "gold")}>{sel.status}</span>
                  <span className="more" onClick={() => setSel(null)}>返回列表</span>
                </h3>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                  <label className="btn ghost sm" style={{ display: "inline-block" }}>
                    📄 上传赛题 PDF（双模复核）
                    <input type="file" accept="application/pdf" hidden onChange={uploadPdf} disabled={!!busy} />
                  </label>
                  <button className="btn ghost sm" onClick={extractFromText} disabled={!!busy}>粘贴文本提取</button>
                  <button className="btn sm" onClick={publish}
                    disabled={sel.status === "published" || critical > 0 || !sel.requirements?.length}>
                    {sel.status === "published" ? "已发布" : "发布标准题目"}
                  </button>
                </div>
                {busy && <p className="hint" style={{ marginTop: 8 }}><span className="spinner" /> {busy}</p>}
                {critical > 0 && <div className="issue blocker" style={{ marginTop: 8 }}>还有 {critical} 处关键差异（指标/分值）未确认，不能发布</div>}
              </div>

              {diffs.length > 0 && (
                <div className="card">
                  <h3>双模复核差异 <span className="hint" style={{ fontWeight: 400 }}>两个模型独立提取后由程序对比</span></h3>
                  {diffs.map((d) => (
                    <div key={d.id} className={"issue " + (d.severity === "critical" ? "blocker" : d.severity === "warning" ? "warning" : "info")}
                      style={{ display: "block", opacity: d.resolved ? 0.5 : 1 }}>
                      <span className="tag">{d.severity}</span> <b>{d.field_path}</b>
                      <table className="data" style={{ margin: "6px 0" }}>
                        <tbody>
                          <tr><td style={{ width: 90 }}>{d.provider_a}</td><td>{d.value_a}</td></tr>
                          <tr><td>{d.provider_b}</td><td>{d.value_b}</td></tr>
                        </tbody>
                      </table>
                      {!d.resolved ? (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button className="btn sm" onClick={() => resolveDiff(d.id, `采信 ${d.provider_a}`)}>采信 {d.provider_a}</button>
                          <button className="btn sm" onClick={() => resolveDiff(d.id, `采信 ${d.provider_b}`)}>采信 {d.provider_b}</button>
                          <button className="btn ghost sm" onClick={() => resolveDiff(d.id, "人工核对无误")}>核对无误</button>
                        </div>
                      ) : <span className="chip green">✓ {d.resolution}</span>}
                    </div>
                  ))}
                </div>
              )}

              {sel.requirements?.length > 0 && (
                <div className="card">
                  <h3>结构化需求（{sel.requirements.length} 条）</h3>
                  {sel.requirements.map((r: any) => (
                    <div key={r.id} className="req-item">
                      <span className="rid">{r.id}</span>
                      <span style={{ flex: 1 }}>{r.description}
                        {r.target != null && <span className="hint">（{r.target}{r.unit || ""}{r.tolerance ? ` ${r.tolerance}` : ""}）</span>}
                        {r.source && <><br /><span className="hint">📎 {r.source}{r.source_page ? ` · 第${r.source_page}页` : ""}</span></>}
                      </span>
                      {r.priority === "mandatory" && <span className="must">基本</span>}
                    </div>
                  ))}
                </div>
              )}

              {sel.scoring_items?.length > 0 && (
                <div className="card">
                  <h3>评分项（{sel.scoring_items.length} 项）</h3>
                  <table className="data">
                    <thead><tr><th>项目</th><th>分值</th><th>口径</th><th>关联需求</th></tr></thead>
                    <tbody>
                      {sel.scoring_items.map((s: any, i: number) => (
                        <tr key={i}>
                          <td>{s.item}</td><td>{s.points ?? "—"}</td>
                          <td><span className={"chip " + (s.points_type === "official" ? "green" : "gold")}>{s.points_type === "official" ? "官方" : "估算"}</span></td>
                          <td className="hint">{(s.requirement_ids || []).join("、")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <div className="card">
              <h3>题目列表</h3>
              <table className="data">
                <thead><tr><th>年份</th><th>题号</th><th>名称</th><th>状态</th><th>待确认差异</th><th></th></tr></thead>
                <tbody>
                  {list.map((p) => (
                    <tr key={p.problem_id}>
                      <td>{p.year}</td><td><b>{p.code}</b></td><td>{p.title}</td>
                      <td><span className={"chip " + (p.status === "published" ? "green" : "gold")}>{p.status}</span></td>
                      <td>{Number(p.open_diffs) > 0 ? <span className="chip red">{p.open_diffs}</span> : "—"}</td>
                      <td><button className="btn ghost sm" disabled={loadingId === p.problem_id}
                        onClick={() => openProblem(p.problem_id)}>
                        {loadingId === p.problem_id ? "打开中…" : "打开"}</button></td>
                    </tr>
                  ))}
                  {!list.length && <tr><td colSpan={6} className="hint">{taxonomyReady ? "还没有题目，右侧新建" : (
                    <>
                      ⚠ 数据库结构落后于当前版本（缺少赛题分类列），列表可能不完整。
                      <br />请执行迁移后刷新：<code>DATABASE_URL=... npm run db:init</code>
                    </>
                  )}</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card" style={{ position: "sticky", top: 12 }}>
          <h3>新建题目</h3>
          <div style={{ display: "grid", gap: 8 }}>
            <label className="hint">年份
              <input type="number" value={form.year} onChange={(e) => setForm({ ...form, year: Number(e.target.value) })}
                style={{ width: "100%", padding: 7, border: "1px solid var(--line)", borderRadius: 8 }} /></label>
            <label className="hint">题号
              <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                style={{ width: "100%", padding: 7, border: "1px solid var(--line)", borderRadius: 8 }} /></label>
            <label className="hint">题目名称
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="如：多径信道模拟器"
                style={{ width: "100%", padding: 7, border: "1px solid var(--line)", borderRadius: 8 }} /></label>
            <label className="hint">组别
              <select value={form.group_name} onChange={(e) => setForm({ ...form, group_name: e.target.value })}
                style={{ width: "100%", padding: 7, border: "1px solid var(--line)", borderRadius: 8 }}>
                <option>本科组</option><option>高职高专组</option><option>不分组</option>
              </select></label>
            <button className="btn sm" onClick={create}>创建</button>
          </div>
          <p className="hint" style={{ marginTop: 10 }}>
            流程：创建条目 → 上传 PDF（国内模型提取 + 另一家复核）→ 程序列出差异 → 人工确认关键项 → 发布。
            发布后用户采用该题目<b>不消耗任何模型调用</b>。
          </p>
          {msg && <p className="hint" style={{ marginTop: 8 }}>{msg}</p>}
        </div>
      </div>
    </div>
  );
}
