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
    // API 对非管理员不报错，只是把未发布题目过滤掉 —— 若据此认为已登录，
    // 界面会显示「还没有题目」，掩盖「其实没登录」这个真实原因
    if (d.staff !== true) { setAuthed(false); return; }
    setList(d.problems || []);
    setTaxonomyReady(d.taxonomy_ready !== false);
    setAuthed(true);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function login() {
    const r = await fetch("/api/admin/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
    if (r.ok) { setKey(""); load(); } else setMsg("密钥错误");
  }

  async function removeProblem(p: any) {
    const label = `${p.year} ${p.code} ${p.title}`;
    if (!confirm(`确定删除「${label}」？\n\n将一并删除其所有版本、需求与评分项，且不可恢复。`)) return;
    setMsg("");
    const res = await fetch(`/api/problems/${p.problem_id}`, { method: "DELETE" });
    const d = await res.json().catch(() => null);

    if (res.status === 409) {
      // 已发布或被项目引用：需要二次确认才强制删除
      if (!confirm(`${d?.error || "该题目存在引用"}\n\n仍要强制删除吗？`)) return;
      const f = await fetch(`/api/problems/${p.problem_id}?force=1`, { method: "DELETE" });
      const fd = await f.json().catch(() => null);
      if (!f.ok) { setMsg(`删除失败：${fd?.error || f.status}`); return; }
      setMsg(`已强制删除「${label}」`);
    } else if (!res.ok) {
      setMsg(`删除失败：${d?.error || res.status}`);
      return;
    } else {
      setMsg(`已删除「${label}」（含 ${d?.deleted?.versions ?? 0} 个版本）`);
    }

    if (sel?.problem_id === p.problem_id) setSel(null);
    load();
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
      // 接口返回 { version, requirements, scoringItems, notes, reviews, checklist }，
      // version 里已带 problem_id / year / code / title
      if (!d?.version) {
        setMsg("接口未返回版本内容。该题可能尚无版本记录。");
        return;
      }
      // 平铺成前端期望的结构：版本字段 + requirements/scoringItems/notes
      setSel({
        ...d.version,
        requirements: d.requirements || [],
        scoringItems: d.scoringItems || [],
        notes: d.notes || [],
        reviews: d.reviews || [],
        checklist: d.checklist || null,
      });

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
    // 导入的题目题面已在库里，无需再让用户粘一遍
    let text = sel.raw_text || "";
    if (text) {
      if (!confirm(`使用已入库的题面原文执行提取（${text.length} 字）？\n\n取消则改为手工粘贴。`)) {
        text = prompt("粘贴赛题原文：") || "";
      }
    } else {
      text = prompt("粘贴赛题原文（也可直接上传 PDF）：") || "";
    }
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

  async function confirmAll() {
    if (!sel) return;
    const n = (sel.requirements || []).filter((r: any) => !["CONFIRMED", "REJECTED"].includes(r.status)).length;
    if (!n) { setMsg("所有需求都已确认或驳回"); return; }
    if (!confirm(`将 ${n} 条待确认需求一次性标记为已确认？\n\n` +
      `请先核对数值单位与基本/发挥分类 —— 确认后这些内容会随发布提供给用户。`)) return;
    setBusy("确认中…");
    await fetch(`/api/problems/${sel.problem_id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version_id: sel.version_id, action: "confirm_all" }),
    });
    setBusy("");
    setMsg(`已确认 ${n} 条需求`);
    openProblem(sel.problem_id);
  }

  async function resolveAllNotes() {
    if (!sel) return;
    const pending = (sel.notes || []).filter((n: any) => n.kind === "ambiguity" && n.resolved !== 1);
    if (!pending.length) { setMsg("没有待处理的题面歧义"); return; }
    if (!confirm(`将 ${pending.length} 条题面歧义标记为已处理？`)) return;
    setBusy("处理中…");
    for (const n of pending) {
      await fetch(`/api/problems/${sel.problem_id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version_id: sel.version_id, action: "resolve_note", note_id: n.note_id }),
      });
    }
    setBusy("");
    setMsg(`已处理 ${pending.length} 条歧义`);
    openProblem(sel.problem_id);
  }

  async function resolveDiff(id: number, resolution: string) {
    await fetch(`/api/problems/${sel.problem_id}/diffs`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ diff_id: id, resolution }),
    });
    openProblem(sel.problem_id);
  }

  async function publish(override = false) {
    setBusy(override ? "强制发布中…" : "发布中…");
    const r = await fetch(`/api/problems/${sel.problem_id}/publish`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version_id: sel.version_id, override }),
    }).then((x) => x.json()).catch(() => null);
    setBusy("");
    if (r?.ok) {
      setMsg(override
        ? "已强制发布（发布记录标注 override，可在版本历史中追溯）"
        : "已发布！用户现在可以直接选用该题目（零模型调用）");
      load(); openProblem(sel.problem_id);
    } else setMsg(r?.error || "发布失败");
  }

  async function publishWithOverride() {
    const unmet = (sel?.checklist || []).filter((c: any) => !c.ok).map((c: any) => c.label);
    if (!confirm(
      `以下清单项未通过：\n${unmet.map((x: string) => "· " + x).join("\n")}\n\n` +
      `强制发布后学生将直接使用这份内容。发布记录会标注 override 以便追溯。\n确定继续？`
    )) return;
    publish(true);
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
                  <button className="btn ghost sm" onClick={extractFromText} disabled={!!busy}>
                    {sel.raw_text ? "用已入库题面提取" : "粘贴文本提取"}</button>
                  <button className="btn sm" onClick={() => publish(false)}
                    disabled={sel.status === "published" || critical > 0 || !sel.requirements?.length}>
                    {sel.status === "published" ? "已发布" : "发布标准题目"}
                  </button>
                </div>
                {busy && <p className="hint" style={{ marginTop: 8 }}><span className="spinner" /> {busy}</p>}
                {critical > 0 && <div className="issue blocker" style={{ marginTop: 8 }}>还有 {critical} 处关键差异（指标/分值）未确认，不能发布</div>}

                {/* 发布清单逐项显示，让人知道差什么、怎么补，而不是只报一句「未通过」 */}
                {sel.checklist && sel.status !== "published" && (
                  <div style={{ marginTop: 10 }}>
                    <p className="hint" style={{ margin: "0 0 6px" }}>发布清单</p>
                    {sel.checklist.map((c: any) => (
                      <div key={c.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 13 }}>
                        <span style={{ color: c.ok ? "var(--green, #16a34a)" : "var(--red, #dc2626)" }}>
                          {c.ok ? "✓" : "✗"}
                        </span>
                        <span style={{ flex: 1, color: c.ok ? "var(--muted)" : "inherit" }}>{c.label}</span>
                        {!c.ok && c.key === "requirements_confirmed" && (
                          <button className="btn ghost sm" onClick={confirmAll} disabled={!!busy}>全部确认</button>
                        )}
                        {!c.ok && c.key === "ambiguities_resolved" && (
                          <button className="btn ghost sm" onClick={resolveAllNotes} disabled={!!busy}>全部处理</button>
                        )}
                        {!c.ok && c.key === "has_source_refs" && (
                          <span className="hint">需重新提取（新版会带原文引用）</span>
                        )}
                        {!c.ok && c.key === "reviewer_count" && (
                          <span className="hint">需两名工作人员分别审核</span>
                        )}
                      </div>
                    ))}
                    {sel.checklist.some((c: any) => !c.ok) && (
                      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                        <button className="btn ghost sm danger" onClick={publishWithOverride} disabled={!!busy}>
                          强制发布（跳过未通过项）
                        </button>
                        <span className="hint">仅在确认内容无误时使用；发布记录会标注 override</span>
                      </div>
                    )}
                  </div>
                )}
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

              {/* 已导入题面但还没提取结构化需求时，页面原本一片空白，
                  既看不到题面也不知道下一步该做什么 */}
              {!sel.requirements?.length && (
                <div className="card">
                  <h3>尚未提取结构化需求</h3>
                  {sel.raw_text ? (
                    <>
                      <p className="hint" style={{ margin: "4px 0 10px" }}>
                        题面原文已入库（{String(sel.raw_text).length} 字）。
                        点上方「粘贴文本提取」可直接对这段原文执行双模复核；
                        若有官方 PDF，用「上传赛题 PDF」提取更准确（含完整评分表）。
                      </p>
                      <details>
                        <summary className="hint" style={{ cursor: "pointer" }}>查看题面原文</summary>
                        <pre style={{
                          whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.7,
                          maxHeight: 420, overflow: "auto", marginTop: 8,
                          padding: 10, background: "var(--bg2, #f7f8fa)", borderRadius: 8,
                        }}>{sel.raw_text}</pre>
                      </details>
                    </>
                  ) : (
                    <p className="hint">
                      该版本没有题面原文。请用「上传赛题 PDF」或「粘贴文本提取」录入题面。
                    </p>
                  )}
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
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button className="btn ghost sm" disabled={loadingId === p.problem_id}
                          onClick={() => openProblem(p.problem_id)}>
                          {loadingId === p.problem_id ? "打开中…" : "打开"}</button>
                        <button className="btn ghost sm danger" style={{ marginLeft: 4 }}
                          title="删除该题目及其所有版本"
                          onClick={() => removeProblem(p)}>删除</button>
                      </td>
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
