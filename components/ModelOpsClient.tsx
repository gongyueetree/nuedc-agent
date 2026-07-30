"use client";
import { useCallback, useEffect, useState } from "react";

/** 模型运维面板：Provider 健康、队列、用量成本、系统模式。 */
export default function ModelOpsClient() {
  const [health, setHealth] = useState<any>(null);
  const [usage, setUsage] = useState<any>(null);
  const [mode, setMode] = useState<any>(null);
  const [days, setDays] = useState(1);
  const [msg, setMsg] = useState("");
  const [authed, setAuthed] = useState(false);
  const [key, setKey] = useState("");

  const load = useCallback(async () => {
    const [h, u, m] = await Promise.all([
      fetch("/api/admin/model-health").then((r) => r.json()).catch(() => null),
      fetch(`/api/admin/model-usage?days=${days}`).then((r) => r.json()).catch(() => null),
      fetch("/api/admin/system-mode").then((r) => r.json()).catch(() => null),
    ]);
    if (h?.error) { setAuthed(false); return; }
    setHealth(h); setUsage(u); setMode(m); setAuthed(true);
  }, [days]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!authed) return;
    // 60 秒刷新即可，且标签页不可见时暂停 —— 运维台常被挂在后台，
    // 15 秒一次会持续消耗数据库流量
    let t: any = setInterval(load, 60_000);
    const onVis = () => {
      if (document.hidden) { clearInterval(t); t = null; }
      else if (!t) { load(); t = setInterval(load, 60_000); }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => { if (t) clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [authed, load]);

  async function login() {
    const r = await fetch("/api/admin/session", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }),
    });
    if (r.ok) { setKey(""); load(); } else setMsg("密钥错误");
  }

  async function toggleProvider(provider: string, action: "enable" | "disable") {
    await fetch("/api/admin/model-health", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, action, minutes: 30 }),
    });
    setMsg(`${provider} 已${action === "enable" ? "启用" : "禁用 30 分钟"}`);
    load();
  }

  async function switchMode(m: string) {
    await fetch("/api/admin/system-mode", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: m }),
    });
    setMsg(`系统模式已切换为 ${m}`);
    load();
  }

  if (!authed) {
    return (
      <div className="shell" style={{ display: "block", padding: 40 }}>
        <div className="card" style={{ maxWidth: 420, margin: "80px auto" }}>
          <h3>模型运维面板</h3>
          <p className="hint">需要管理员密钥（ADMIN_API_KEY）</p>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") login(); }}
            style={{ width: "100%", padding: 9, border: "1px solid var(--line)", borderRadius: 8, margin: "8px 0" }} />
          <button className="btn" style={{ width: "100%" }} onClick={login}>登录</button>
          {msg && <p className="hint" style={{ color: "var(--red)" }}>{msg}</p>}
        </div>
      </div>
    );
  }

  const t = usage?.total || {};
  return (
    <div style={{ padding: "20px 28px", maxWidth: 1280, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 4px" }}>模型运维</h2>
      <p className="hint">15 秒自动刷新 · 队列 {mode?.queue_length ?? 0} 个任务</p>

      {/* 系统模式 */}
      <div className="card" style={{ marginTop: 14 }}>
        <h3>系统模式 <span className={"chip " + (mode?.mode === "NORMAL" ? "green" : "gold")}>{mode?.label || mode?.mode}</span></h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          {(mode?.modes || []).map((m: string) => (
            <button key={m} className={"btn sm" + (mode?.mode === m ? "" : " ghost")} onClick={() => switchMode(m)}>{m}</button>
          ))}
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          DEGRADED 暂停 P2/P3 任务（备选方案、报告润色、问答）；RULES_ONLY 停止全部模型生成但保留规则工具与项目编辑；READ_ONLY 仅查看导出。
        </p>
      </div>

      {/* Provider 健康 */}
      <div className="card" style={{ marginTop: 14 }}>
        <h3>Provider 状态</h3>
        <table className="data">
          <thead><tr><th>Provider</th><th>配置</th><th>状态</th><th>成功率</th><th>429 率</th><th>P95 延迟</th><th>样本</th><th>操作</th></tr></thead>
          <tbody>
            {(health?.routing?.providers || []).map((p: any) => {
              const h = (health?.health || []).find((x: any) => x.provider === p.id);
              const disabled = h?.status === "disabled";
              return (
                <tr key={p.id}>
                  <td><b>{p.label}</b><br /><span className="hint">{p.models?.text || "—"}</span></td>
                  <td>{p.configured ? <span className="chip green">已配置</span> : <span className="chip">未配置</span>}</td>
                  <td>{!p.configured ? "—" : disabled
                    ? <span className="chip red">熔断至 {String(h.disabledUntil).slice(11, 16)}</span>
                    : <span className="chip green">正常</span>}</td>
                  <td>{h?.samples ? `${(h.successRate * 100).toFixed(0)}%` : "—"}</td>
                  <td>{h?.samples ? `${(h.rate429 * 100).toFixed(0)}%` : "—"}</td>
                  <td>{h?.latencyP95 ? `${h.latencyP95}ms` : "—"}</td>
                  <td className="hint">{h?.samples ?? 0}</td>
                  <td>
                    {p.configured && (disabled
                      ? <button className="btn sm" onClick={() => toggleProvider(p.id, "enable")}>启用</button>
                      : <button className="btn ghost sm" onClick={() => toggleProvider(p.id, "disable")}>禁用</button>)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="hint" style={{ marginTop: 8 }}>
          主模型 <b>{health?.routing?.primary}</b> · 容灾链 {health?.routing?.fallback?.join(" → ") || "（未配置）"} ·
          低成本链 {health?.routing?.cheapChain?.slice(0, 3).join(" → ")}
        </p>
      </div>

      {/* 队列 */}
      <div className="card" style={{ marginTop: 14 }}>
        <h3>任务队列（近 1 小时）</h3>
        <div className="statsbar">
          {["queued", "running", "ok", "error", "canceled", "dead"].map((st) => {
            const n = (health?.queue || []).filter((q: any) => q.status === st).reduce((a: number, q: any) => a + q.count, 0);
            return <span key={st}>{st} <b>{n}</b></span>;
          })}
        </div>
        <table className="data" style={{ marginTop: 8 }}>
          <thead><tr><th>优先级</th><th>状态</th><th>数量</th></tr></thead>
          <tbody>
            {(health?.queue || []).map((q: any, i: number) => (
              <tr key={i}><td>P{q.priority}</td><td>{q.status}</td><td>{q.count}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 用量与成本 */}
      <div className="card" style={{ marginTop: 14 }}>
        <h3>用量与成本
          <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            {[1, 7, 30].map((d) => (
              <button key={d} className={"btn sm" + (days === d ? "" : " ghost")} onClick={() => setDays(d)}>{d} 天</button>
            ))}
          </span>
        </h3>
        <div className="statsbar">
          <span>请求 <b>{t.requests ?? 0}</b></span>
          <span>输入 <b>{((t.inputTokens ?? 0) / 1000).toFixed(1)}k</b> tokens</span>
          <span>输出 <b>{((t.outputTokens ?? 0) / 1000).toFixed(1)}k</b> tokens</span>
          <span>估算成本 <b>${(t.costUsd ?? 0).toFixed(4)}</b></span>
          <span>缓存命中 <b>{t.cacheHits ?? 0}</b></span>
          <span>缓存条目 <b>{usage?.cache?.entries ?? 0}</b></span>
        </div>
        <div className="grid cols-2" style={{ marginTop: 10 }}>
          <div>
            <b style={{ fontSize: 13 }}>按 Provider</b>
            <table className="data">
              <thead><tr><th>Provider</th><th>请求</th><th>输出 tokens</th><th>成本</th></tr></thead>
              <tbody>
                {(usage?.byProvider || []).map((r: any) => (
                  <tr key={r.provider}><td>{r.provider}</td><td>{r.requests}</td><td>{(r.outputTokens / 1000).toFixed(1)}k</td><td>${r.costUsd.toFixed(4)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <b style={{ fontSize: 13 }}>按任务类型（成本降序）</b>
            <table className="data">
              <thead><tr><th>taskType</th><th>请求</th><th>输出</th><th>成本</th></tr></thead>
              <tbody>
                {(usage?.byTaskType || []).slice(0, 8).map((r: any) => (
                  <tr key={r.taskType}><td className="hint">{r.taskType}</td><td>{r.requests}</td><td>{(r.outputTokens / 1000).toFixed(1)}k</td><td>${r.costUsd.toFixed(4)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {usage?.budgets && (usage.budgets.perUserDaily || usage.budgets.globalDaily) && (
          <p className="hint" style={{ marginTop: 8 }}>
            预算：每用户 ${usage.budgets.perUserDaily ?? "—"}/日 · 每项目 ${usage.budgets.perProjectDaily ?? "—"}/日 · 全局 ${usage.budgets.globalDaily ?? "—"}/日
          </p>
        )}
      </div>

      {msg && <p className="hint" style={{ marginTop: 10 }}>{msg}</p>}
    </div>
  );
}
