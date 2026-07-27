"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CertBadge } from "./pages-core";
import { CATEGORY_TREE, FLAT_CATEGORIES, categoryLabel, PROTOCOL_ENUM, SOURCE_TYPES } from "../data/categories";

type Toast = { kind: "ok" | "err"; msg: string } | null;
const EMPTY: any = {
  id: "", name: "", category: "sensor.other", version: "1.0.0", description: "",
  main_chip: "", price: 0, interfaces: [], power: {}, tags: [],
  usage_notes: [], known_issues: [], compatibility: [], competition_cases: [],
  schematic_assets: [], code_repositories: [], images: [],
  certification_status: "DRAFT", source_snapshot: { source: "lab" },
};

export default function AdminClient() {
  const [key, setKey] = useState("");
  const [authed, setAuthed] = useState(false);
  const [loginErr, setLoginErr] = useState("");
  const [tab, setTab] = useState<"modules" | "categories" | "governance">("modules");
  const [gov, setGov] = useState<any>(null);
  const [mods, setMods] = useState<any[]>([]);
  const [filter, setFilter] = useState("");
  const [catFilter, setCatFilter] = useState("");
  const [draft, setDraft] = useState<any>(null);
  const [isNew, setIsNew] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  // 组织身份与归属分组（ezPLM 组织管理员登录时生效）
  const [orgInfo, setOrgInfo] = useState<{ org: string | null; role: string | null; counts: any }>({ org: null, role: null, counts: null });
  const [scopeTab, setScopeTab] = useState<"all" | "org" | "mine" | "public">("all");

  const H = useCallback((_k?: string) => ({ "content-type": "application/json" }), []);  // 鉴权走 httpOnly cookie
  const flash = (kind: "ok" | "err", msg: string) => { setToast({ kind, msg }); setTimeout(() => setToast(null), 2600); };

  const load = useCallback(async (_k?: string) => {
    const g = await fetch("/api/modules/governance");
    if (!g.ok) throw new Error((await g.json()).error || "未授权");
    setGov(await g.json());
    const m = await fetch(`/api/modules?status=all&limit=500&scope=${scopeTab}`);
    const d = await m.json();
    setMods(d.modules || []);
    setOrgInfo({ org: d.org ?? null, role: d.org_role ?? null, counts: d.counts ?? null });
  }, [scopeTab]);

  useEffect(() => {
    // 已有会话 cookie 则直接进入
    load().then(() => setAuthed(true)).catch(() => {});
  }, [load]);

  async function login() {
    setLoginErr("");
    const r = await fetch("/api/admin/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
    if (!r.ok) { setLoginErr((await r.json()).error || "密钥错误"); return; }
    setKey("");                      // 密钥用后即弃，不存任何浏览器存储
    await load(); setAuthed(true);
  }

  function openEditor(m: any) { setDraft(JSON.parse(JSON.stringify(m))); setIsNew(false); }
  function newModule() { setDraft({ ...JSON.parse(JSON.stringify(EMPTY)) }); setIsNew(true); }

  async function review(id: string, result: "approved" | "rejected") {
    const r = await fetch(`/api/modules/${id}/review`, { method: "POST", headers: H(key), body: JSON.stringify({ result }) });
    const d = await r.json();
    flash(r.ok ? "ok" : "err", r.ok ? `${id}：${d.from_status} → ${d.to_status}` : d.error);
    load(key);
  }

  async function save() {
    if (!draft.id || !draft.name) return flash("err", "id 与 name 为必填");
    const url = isNew ? "/api/modules" : `/api/modules/${draft.id}`;
    const method = isNew ? "POST" : "PATCH";
    const body = isNew ? draft : (({ id, certification_status, _completeness, downloads, rating, ...rest }: any) => rest)(draft);
    const r = await fetch(url, { method, headers: H(key), body: JSON.stringify(body) });
    const d = await r.json();
    if (r.ok) { flash("ok", isNew ? "已创建（DRAFT 待审核）" : "已保存"); setDraft(null); load(key); }
    else flash("err", d.error || "保存失败");
  }

  function exportAll() {
    const blob = new Blob([JSON.stringify(mods.map(({ _completeness, downloads, rating, ...m }) => m), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `nuedc-modules-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  }

  const filtered = useMemo(() => mods.filter((m) =>
    (!catFilter || String(m.category).startsWith(catFilter)) &&
    (!filter || `${m.name} ${m.id} ${m.main_chip}`.toLowerCase().includes(filter.toLowerCase()))
  ), [mods, filter, catFilter]);

  if (!authed) return (
    <div className="page" style={{ maxWidth: 420, paddingTop: 70 }}>
      <div className="card">
        <h3>模块数据库 · 编辑后台</h3>
        <p className="hint">输入管理员密钥（部署环境变量 <code>ADMIN_API_KEY</code>）。</p>
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && login()} placeholder="ADMIN_API_KEY"
          style={{ width: "100%", padding: 9, borderRadius: 8, border: "1px solid var(--line)", margin: "8px 0" }} />
        {loginErr && <div className="issue blocker">{loginErr}</div>}
        <button className="btn" style={{ width: "100%" }} onClick={login}>进入后台</button>
      </div>
    </div>
  );

  return (
    <div className="cms">
      <div className="cms-bar">
        <b>模块数据库 CMS</b>
        <div className="seg">
          <button className={tab === "modules" ? "on" : ""} onClick={() => setTab("modules")}>模块</button>
          {/* 分类体系与全局治理属于平台职责，组织管理员不参与 */}
          {orgInfo.role !== "org_admin" && (
            <>
              <button className={tab === "categories" ? "on" : ""} onClick={() => setTab("categories")}>分类管理</button>
              <button className={tab === "governance" ? "on" : ""} onClick={() => setTab("governance")}>数据治理</button>
            </>
          )}
        </div>
        <span style={{ flex: 1 }} />
        <a className="btn ghost sm" href="/">站点首页</a>
        <button className="btn ghost sm" onClick={exportAll}>⬇ 导出</button>
        <button className="btn ghost sm" onClick={async () => { await fetch("/api/admin/session", { method: "DELETE" }); setAuthed(false); }}>退出</button>
      </div>

      {tab === "governance" && <Governance gov={gov} onReview={review} />}
      {tab === "categories" && <Categories mods={mods} />}

      {tab === "modules" && (
        <div className="cms-body">
          <div className="cms-list">
            <button className="btn sm" style={{ width: "100%", marginBottom: 8 }} onClick={newModule}>＋ 新建模块</button>
            {orgInfo.role === "org_admin" && (
              <div className="issue info" style={{ display: "block", marginBottom: 8 }}>
                你以<b>组织管理员</b>身份登录（{orgInfo.org}）。可编辑本组织模块，
                认证状态最高可评定到 FUNCTION_TESTED；公共模块库由平台维护，此处只读。
              </div>
            )}
            <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
              {([
                ["all", "全部可见"], ["org", "本组织"], ["mine", "我的"], ["public", "公共库"],
              ] as const).map(([k, label]) => (
                <button key={k} className={"fchip" + (scopeTab === k ? " on" : "")} onClick={() => setScopeTab(k)}>
                  {label}{orgInfo.counts ? ` ${orgInfo.counts[k] ?? 0}` : ""}
                </button>
              ))}
            </div>
            <input placeholder="搜索 名称 / id / 芯片…" value={filter} onChange={(e) => setFilter(e.target.value)}
              style={{ width: "100%", padding: 7, borderRadius: 7, border: "1px solid var(--line)", marginBottom: 6 }} />
            <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)}
              style={{ width: "100%", padding: 7, borderRadius: 7, border: "1px solid var(--line)", marginBottom: 8 }}>
              <option value="">全部分类</option>
              {CATEGORY_TREE.map((g) => <option key={g.key} value={g.key}>{g.icon} {g.label}</option>)}
            </select>
            <div className="hint" style={{ marginBottom: 6 }}>{filtered.length} / {mods.length} 个</div>
            {filtered.map((m) => (
              <div key={m.id} className={"cms-row" + (draft?.id === m.id ? " on" : "")} onClick={() => openEditor(m)}>
                <div style={{ minWidth: 0 }}>
                  <div className="rn">{m.name}</div>
                  <div className="ri">{m.id} · {categoryLabel(m.category)}</div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <CertBadge s={m.certification_status} />
                  <div className="hint" style={{ fontSize: 11 }}>{m._completeness ?? "—"}%</div>
                </div>
              </div>
            ))}
          </div>

          <div className="cms-editor">
            {draft ? <Editor draft={draft} setDraft={setDraft} isNew={isNew} orgRole={orgInfo.role} onSave={save} onCancel={() => setDraft(null)}
              onReview={!isNew ? review : undefined} />
              : <div className="cms-empty">← 从左侧选择模块编辑<br />或点「新建模块」</div>}
          </div>
        </div>
      )}

      {toast && <div className={"cms-toast " + toast.kind}>{toast.msg}</div>}
    </div>
  );
}

/* ============ 分区表单编辑器 ============ */
/** 从图片列表里挑出外链 URL；上传的 base64 图片不进输入框 */
function linkOnly(images: string[] | undefined): string[] {
  return (images || []).filter((x) => typeof x === "string" && !x.startsWith("data:"));
}

function Editor({ draft, setDraft, isNew, onSave, onCancel, onReview, orgRole }: any) {
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  // 题库列表用于关联历届应用；失败不阻断编辑，退化为手工填写
  const [problemOptions, setProblemOptions] = useState<any[]>([]);
  useEffect(() => {
    fetch("/api/problems?status=")
      .then((r) => r.json())
      .then((d) => setProblemOptions(d.problems || []))
      .catch(() => setProblemOptions([]));
  }, []);

  /** 上传图片：浏览器端压缩到合理尺寸后存为 data URL。
   *  这样图片随模块数据一起保存，不需要外部图床，也不会遇到淘宝那类站点的防盗链。 */
  async function uploadImages(files: FileList | null) {
    if (!files?.length) return;
    const MAX_EDGE = 800;          // 长边上限，够看清模块丝印与接口
    const MAX_BYTES = 320 * 1024;  // 单张上限，避免撑爆数据库行
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;

    setUploading({ done: 0, total: list.length });
    const out: string[] = [];

    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      try {
        // createImageBitmap 直接从 File 解码，跳过 FileReader→dataURL→Image 三次转换，
        // 大图上传明显更快；解码在浏览器内部线程完成，不阻塞界面
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();

        // 按像素数预估质量，一次编码到位；只有仍超限才再压一次，
        // 避免此前「循环降质最多重编码 4 次」的卡顿
        const px = canvas.width * canvas.height;
        let quality = px > 400_000 ? 0.72 : px > 160_000 ? 0.8 : 0.86;
        let blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", quality));
        if (blob && blob.size > MAX_BYTES) {
          quality = Math.max(0.45, quality * (MAX_BYTES / blob.size) * 0.9);
          blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", quality));
        }
        if (!blob) throw new Error("编码失败");

        const dataUrl = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result));
          r.onerror = () => rej(new Error("读取失败"));
          r.readAsDataURL(blob!);
        });
        out.push(dataUrl);
      } catch {
        console.warn(`图片 ${file.name} 处理失败`);
      }
      setUploading({ done: i + 1, total: list.length });
    }

    if (out.length) setDraft((d: any) => ({ ...d, images: [...(d.images || []), ...out] }));
    setUploading(null);
  }

  const set = (k: string, v: any) => setDraft({ ...draft, [k]: v });
  const setNested = (obj: string, k: string, v: any) => setDraft({ ...draft, [obj]: { ...(draft[obj] || {}), [k]: v } });
  const lines = (arr?: string[]) => (arr || []).join("\n");
  const parseLines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

  // 接口行编辑
  function updIface(i: number, patch: any) {
    const ifs = [...(draft.interfaces || [])]; ifs[i] = { ...ifs[i], ...patch }; set("interfaces", ifs);
  }
  function addIface() { set("interfaces", [...(draft.interfaces || []), { name: "", interface_type: "UART", role: "either", pins: [], constraints: [] }]); }
  function delIface(i: number) { set("interfaces", draft.interfaces.filter((_: any, j: number) => j !== i)); }

  // 历届案例行
  function updCase(i: number, patch: any) { const cs = [...(draft.competition_cases || [])]; cs[i] = { ...cs[i], ...patch }; set("competition_cases", cs); }
  function addCase() { set("competition_cases", [...(draft.competition_cases || []), { year: new Date().getFullYear(), problem: "", note: "" }]); }
  function delCase(i: number) { set("competition_cases", draft.competition_cases.filter((_: any, j: number) => j !== i)); }

  return (
    <div className="editor-form">
      <div className="ef-head">
        <h3 style={{ margin: 0 }}>{isNew ? "新建模块" : `编辑 · ${draft.id}`}</h3>
        <CertBadge s={draft.certification_status} />
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={onCancel}>取消</button>
        <button className="btn sm" onClick={onSave}>{isNew ? "创建" : "保存"}</button>
      </div>

      <section>
        <h4>基本信息</h4>
        <div className="ef-grid">
          <F label="ID（引擎使用，小写/数字/下划线）"><input value={draft.id} disabled={!isNew}
            onChange={(e) => set("id", e.target.value)} placeholder="sensor-bmp280" /></F>
          <F label="名称"><input value={draft.name} onChange={(e) => set("name", e.target.value)} /></F>
          <F label="分类">
            <select value={draft.category} onChange={(e) => set("category", e.target.value)}>
              {FLAT_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </F>
          <F label="主芯片"><input value={draft.main_chip || ""} onChange={(e) => set("main_chip", e.target.value)} placeholder="BMP280" /></F>
          <F label="版本"><input value={draft.version || "1.0.0"} onChange={(e) => set("version", e.target.value)} /></F>
          <F label="认证状态（只读，通过下方审核动作变更）">
            <input value={draft.certification_status} disabled />
          </F>
          <F label="标签（逗号分隔）"><input value={(draft.tags || []).join(", ")}
            onChange={(e) => set("tags", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} /></F>
        </div>
        <F label="描述"><textarea value={draft.description || ""} onChange={(e) => set("description", e.target.value)} style={{ minHeight: 56 }} /></F>
        <F label="可见范围">
          <select value={draft.scope || "PUBLIC"} onChange={(e) => set("scope", e.target.value)}
            disabled={draft.scope === "PUBLIC" && orgRole === "org_admin"}>
            <option value="PUBLIC">公共库（所有用户可见）</option>
            <option value="ORGANIZATION">本组织（仅本组织成员可见）</option>
            <option value="PERSONAL">仅自己可见</option>
          </select>
          <p className="hint" style={{ margin: "4px 0 0" }}>
            实际归属以服务端身份为准：组织用户创建的模块自动归本组织，不会写入公共库。
          </p>
        </F>
        <F label="图片">
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label className="btn sm" style={{ display: "inline-block", cursor: "pointer" }}>
              📷 上传图片
              <input type="file" accept="image/*" multiple hidden
                onChange={(e) => uploadImages(e.target.files)} />
            </label>
            <span className="hint">
              {uploading
                ? `正在处理 ${uploading.done}/${uploading.total}…`
                : "支持多选 · 自动压缩后随模块保存，无需图床"}
            </span>
          </div>
          {/* 输入框只承载外链 URL。上传的图片是 base64 数据（往往几十万字符），
              放进来会挤满整个框、既看不懂也没法编辑，因此只在下方以缩略图呈现。 */}
          <textarea
            value={linkOnly(draft.images).join("\n")}
            onChange={(e) => {
              const links = parseLines(e.target.value);
              const uploaded = (draft.images || []).filter((x: string) => x.startsWith("data:"));
              set("images", [...uploaded, ...links]);   // 保留已上传的图片
            }}
            placeholder="也可直接粘贴图片 URL，每行一个"
            style={{ minHeight: 36, marginTop: 6 }} />
          {(draft.images || []).some((x: string) => x.startsWith("data:")) && (
            <p className="hint" style={{ margin: "4px 0 0" }}>
              另有 {(draft.images || []).filter((x: string) => x.startsWith("data:")).length} 张已上传的图片
              （数据随模块保存，不占用输入框）
            </p>
          )}
        </F>
        {(draft.images || []).length > 0 && (
          <div className="module-gallery" style={{ marginTop: -6 }}>
            {(draft.images || []).map((src: string, i: number) => (
              <div key={i} style={{ position: "relative" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={`图 ${i + 1}`} loading="lazy"
                  onError={(e) => {
                    const el = e.currentTarget as HTMLImageElement;
                    el.style.opacity = "0.25";
                    el.title = "图片无法加载，请检查链接是否可公开访问";
                  }} />
                <button type="button" className="btn ghost sm"
                  style={{ position: "absolute", top: 4, right: 4, padding: "1px 6px", fontSize: 11 }}
                  onClick={() => set("images", draft.images.filter((_: string, j: number) => j !== i))}>删</button>
              </div>
            ))}
          </div>
        )}
        <p className="hint" style={{ marginTop: -4 }}>
          图片需为可公开访问的直链（右键「复制图片地址」得到的 URL）。淘宝等站点的图片可能有防盗链，
          若预览显示为半透明说明无法加载，建议上传到图床或对象存储后再填。
        </p>
        <F label="工作原理（可选）"><textarea value={draft.principle || ""} onChange={(e) => set("principle", e.target.value)} style={{ minHeight: 44 }} /></F>
      </section>

      <section>
        <h4>接口定义 <button className="btn ghost sm" onClick={addIface}>＋ 添加接口</button></h4>
        <p className="hint">接口是规则引擎的输入 —— 电平、5V 容忍、引脚在这里填。</p>
        {(draft.interfaces || []).map((it: any, i: number) => (
          <div key={i} className="iface-row">
            <div className="ef-grid">
              <F label="接口名"><input value={it.name} onChange={(e) => updIface(i, { name: e.target.value })} placeholder="I2C" /></F>
              <F label="协议">
                <select value={it.interface_type} onChange={(e) => updIface(i, { interface_type: e.target.value })}>
                  {PROTOCOL_ENUM.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </F>
              <F label="角色">
                <select value={it.role || "either"} onChange={(e) => updIface(i, { role: e.target.value })}>
                  {["host", "device", "peer", "either"].map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </F>
              <F label="逻辑电平 (V)"><input type="number" step="0.1" value={it.voltage_level ?? ""} onChange={(e) => updIface(i, { voltage_level: e.target.value === "" ? undefined : Number(e.target.value) })} /></F>
              <F label="最大速率 (bps)"><input type="number" value={it.max_baudrate ?? ""} onChange={(e) => updIface(i, { max_baudrate: e.target.value === "" ? undefined : Number(e.target.value) })} /></F>
              {/* 地址只对 I2C 有意义；其它协议显示会误导录入 */}
              {String(it.interface_type || "").toUpperCase() === "I2C" ? (
                <F label="I2C 地址"><input value={it.address ?? ""} onChange={(e) => updIface(i, { address: e.target.value || undefined })} placeholder="0x76" /></F>
              ) : <div />}
            </div>
            <label className="ck"><input type="checkbox" checked={!!it.five_v_tolerant} onChange={(e) => updIface(i, { five_v_tolerant: e.target.checked })} />5V 容忍</label>
            <F label="引脚（每行 信号=物理脚，如 SDA=PB7）">
              <textarea value={(it.pins || []).map((p: any) => `${p.signal}=${p.pin}`).join("\n")} style={{ minHeight: 40 }}
                onChange={(e) => updIface(i, { pins: parseLines(e.target.value).map((l) => { const [signal, pin] = l.split("="); return { signal: signal?.trim(), pin: (pin || signal)?.trim() }; }) })} />
            </F>
            <F label="约束（每行一条）">
              <textarea value={lines(it.constraints)} style={{ minHeight: 40 }} onChange={(e) => updIface(i, { constraints: parseLines(e.target.value) })} />
            </F>
            <button className="btn ghost sm danger" onClick={() => delIface(i)}>删除此接口</button>
          </div>
        ))}
        {!draft.interfaces?.length && <p className="hint">还没有接口。</p>}
      </section>

      <section>
        <h4>电源参数</h4>
        <div className="ef-grid">
          <F label="供电下限 (V)"><input type="number" step="0.1" value={draft.power?.input_voltage_range?.[0] ?? ""}
            onChange={(e) => setNested("power", "input_voltage_range", [Number(e.target.value), draft.power?.input_voltage_range?.[1] ?? Number(e.target.value)])} /></F>
          <F label="供电上限 (V)"><input type="number" step="0.1" value={draft.power?.input_voltage_range?.[1] ?? ""}
            onChange={(e) => setNested("power", "input_voltage_range", [draft.power?.input_voltage_range?.[0] ?? Number(e.target.value), Number(e.target.value)])} /></F>
          <F label="典型电流 (mA)"><input type="number" value={draft.power?.typical_current_ma ?? ""} onChange={(e) => setNested("power", "typical_current_ma", e.target.value === "" ? undefined : Number(e.target.value))} /></F>
          <F label="峰值电流 (mA)"><input type="number" value={draft.power?.peak_current_ma ?? ""} onChange={(e) => setNested("power", "peak_current_ma", e.target.value === "" ? undefined : Number(e.target.value))} /></F>
        </div>
        <label className="ck"><input type="checkbox" checked={!!draft.power?.has_onboard_regulator} onChange={(e) => setNested("power", "has_onboard_regulator", e.target.checked)} />板载稳压</label>
        <label className="ck"><input type="checkbox" checked={!!draft.power?.can_source_power} onChange={(e) => setNested("power", "can_source_power", e.target.checked)} />可对外供电</label>
      </section>

      <section>
        <h4>工程经验</h4>
        <F label="使用要点（每行一条）"><textarea value={lines(draft.usage_notes)} onChange={(e) => set("usage_notes", parseLines(e.target.value))} style={{ minHeight: 52 }} /></F>
        <F label="已知坑点（每行一条）"><textarea value={lines(draft.known_issues)} onChange={(e) => set("known_issues", parseLines(e.target.value))} style={{ minHeight: 52 }} /></F>
        <F label="兼容 / 可替换模块 id（每行一个）"><textarea value={lines(draft.compatibility)} onChange={(e) => set("compatibility", parseLines(e.target.value))} style={{ minHeight: 40 }} /></F>
      </section>

      <section>
        <h4>采购信息 <span className="hint" style={{ fontWeight: 400 }}>自制/实验室自研模块可留空</span></h4>
        <div className="ef-grid">
          <F label="价格（¥）">
            <input type="number" value={draft.price ?? ""} placeholder="自制模块可不填"
              onChange={(e) => set("price", e.target.value === "" ? undefined : Number(e.target.value))} />
          </F>
          <F label="购买平台">
            <input value={draft.purchase_platform || ""} placeholder="淘宝 / 立创商城 / 官网 / 自制"
              onChange={(e) => set("purchase_platform", e.target.value || undefined)} />
          </F>
        </div>
        <F label="购买链接">
          <input value={draft.purchase_url || ""} placeholder="https://…（自制模块留空）"
            onChange={(e) => set("purchase_url", e.target.value || undefined)} />
        </F>
        {draft.purchase_url && !/^https?:\/\//.test(draft.purchase_url) && (
          <p className="hint" style={{ color: "var(--red)", margin: "4px 0 0" }}>链接需以 http:// 或 https:// 开头</p>
        )}
      </section>

      <section>
        <h4>历届电赛应用 <button className="btn ghost sm" onClick={addCase}>＋ 添加</button></h4>
        <p className="hint" style={{ margin: "0 0 8px" }}>
          从题库选择该模块曾用于哪些赛题；选定后自动带出年份与题目名称，也可手工填写。
        </p>
        {(draft.competition_cases || []).map((c: any, i: number) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1.6fr 0.5fr 1fr auto",
            gap: 8, alignItems: "end", marginBottom: 6 }}>
            <F label="赛题">
              <select value={c.problem_id || ""}
                onChange={(e) => {
                  const p = problemOptions.find((x: any) => x.problem_id === e.target.value);
                  updCase(i, p
                    ? { problem_id: p.problem_id, year: Number(p.year), problem: `${p.code}题 ${p.title}` }
                    : { problem_id: undefined });
                }}>
                <option value="">— 手工填写 —</option>
                {problemOptions.map((p: any) => (
                  <option key={p.problem_id} value={p.problem_id}>
                    {p.year} {p.code} · {p.title}
                  </option>
                ))}
              </select>
            </F>
            <F label="年份"><input type="number" value={c.year}
              onChange={(e) => updCase(i, { year: Number(e.target.value) })} /></F>
            <F label={c.problem_id ? "题目（来自题库）" : "题目"}>
              <input value={c.problem} disabled={!!c.problem_id}
                onChange={(e) => updCase(i, { problem: e.target.value })} placeholder="如：A题 单相逆变器" /></F>
            <button className="btn ghost sm danger" onClick={() => delCase(i)}>删</button>
          </div>
        ))}
      </section>

      <section>
        <h4>参数证据 <button className="btn ghost sm" onClick={() => set("evidence_records", [...(draft.evidence_records || []), { param: "", value: "", evidence_level: "E5", conditions: "", source_id: "" }])}>＋ 添加证据</button></h4>
        <p className="hint">证据等级：E0 AI推断 / E1 商家描述 / E2 社区 / E3 芯片手册 / E4 模块厂文档 / E5 单实验室实测 / E6 多实验室复验。<b>晋级 BENCHMARKED / COMPETITION_READY 至少需要一条 E5+。</b></p>
        {(draft.evidence_records || []).map((ev: any, i: number) => (
          <div key={i} className="ef-grid" style={{ alignItems: "end", marginBottom: 6, gridTemplateColumns: "1.2fr 0.8fr 0.6fr 1.2fr 0.9fr auto" }}>
            <F label="参数路径"><input value={ev.param} placeholder="power.peak_current_ma" onChange={(e) => { const a = [...draft.evidence_records]; a[i] = { ...ev, param: e.target.value }; set("evidence_records", a); }} /></F>
            <F label="实测值"><input value={ev.value} onChange={(e) => { const a = [...draft.evidence_records]; a[i] = { ...ev, value: e.target.value }; set("evidence_records", a); }} /></F>
            <F label="等级"><select value={ev.evidence_level} onChange={(e) => { const a = [...draft.evidence_records]; a[i] = { ...ev, evidence_level: e.target.value }; set("evidence_records", a); }}>
              {["E0","E1","E2","E3","E4","E5","E6"].map((l) => <option key={l}>{l}</option>)}</select></F>
            <F label="测试条件"><input value={ev.conditions || ""} placeholder="12V, 25°C, 无风扇" onChange={(e) => { const a = [...draft.evidence_records]; a[i] = { ...ev, conditions: e.target.value }; set("evidence_records", a); }} /></F>
            <F label="来源编号"><input value={ev.source_id || ""} placeholder="TEST-2026-017" onChange={(e) => { const a = [...draft.evidence_records]; a[i] = { ...ev, source_id: e.target.value }; set("evidence_records", a); }} /></F>
            <button className="btn ghost sm danger" onClick={() => set("evidence_records", draft.evidence_records.filter((_: any, j: number) => j !== i))}>删</button>
          </div>
        ))}
      </section>

      {!isNew && <RevisionSection moduleId={draft.id} />}

      <section>
        <h4>资产与来源 <span className="hint" style={{ fontWeight: 400 }}>（付费门控在 API 层，此处只存 URL）</span></h4>
        <div className="ef-grid">
          <F label="来源类型">
            <select value={draft.source_snapshot?.source || "lab"} onChange={(e) => setNested("source_snapshot", "source", e.target.value)}>
              {SOURCE_TYPES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </F>
          <F label="Datasheet URL"><input value={draft.datasheet_url || ""} onChange={(e) => set("datasheet_url", e.target.value)} /></F>
        </div>
        <F label="原理图资产（每行一个 URL）"><textarea value={lines(draft.schematic_assets)} onChange={(e) => set("schematic_assets", parseLines(e.target.value))} style={{ minHeight: 36 }} /></F>
        <F label="代码仓库（每行一个 URL）"><textarea value={lines(draft.code_repositories)} onChange={(e) => set("code_repositories", parseLines(e.target.value))} style={{ minHeight: 36 }} /></F>
      </section>

      {onReview && (
        <section>
          <h4>审核操作</h4>
          <p className="hint">
            通过 → 沿认证状态机晋级一级；驳回 → 退回 DRAFT。
            {orgRole === "org_admin" && (
              <><br />组织模块最高可评定到 <b>FUNCTION_TESTED</b>；
              BENCHMARKED 与 COMPETITION_READY 由平台实验室统一评定。</>
            )}
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm ok" onClick={() => onReview(draft.id, "approved")}>通过晋级 ↑</button>
            <button className="btn ghost sm danger" onClick={() => onReview(draft.id, "rejected")}>驳回</button>
          </div>
        </section>
      )}
    </div>
  );
}

function F({ label, children }: { label: string; children: any }) {
  return <label className="ef-field"><span>{label}</span>{children}</label>;
}

/* ============ 分类管理 ============ */
function Categories({ mods }: { mods: any[] }) {
  const count = (prefix: string) => mods.filter((m) => String(m.category).startsWith(prefix)).length;
  return (
    <div className="page">
      <div className="card" style={{ marginBottom: 14 }}>
        <h3>分类体系</h3>
        <p className="hint">采用「大类 / 子类」两级分层，编码为 <code>大类.子类</code>（如 <code>actuator.motor_driver</code>）。模块选型页的筛选、编辑表单的下拉、方案框图的角色识别都读这份分类。要新增分类，编辑 <code>data/categories.ts</code> 的 <code>CATEGORY_TREE</code> 即可（改动后所有下拉自动更新）。</p>
      </div>
      <div className="grid cols-3">
        {CATEGORY_TREE.map((g) => (
          <div key={g.key} className="card">
            <h3>{g.icon} {g.label} <span className="hint" style={{ fontWeight: 400 }}>{count(g.key)} 个</span></h3>
            {g.children.map((c) => (
              <div key={c.key} className="req-item" style={{ padding: "5px 0" }}>
                <span>{c.label}</span>
                <span style={{ marginLeft: "auto" }} className="chip">{count(c.key)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============ 数据治理 ============ */
function Governance({ gov, onReview }: any) {
  if (!gov) return <div className="page"><p className="hint">加载中…</p></div>;
  return (
    <div className="page">
      <div className="statsbar" style={{ marginBottom: 14 }}>
        <span><b>{gov.totalModules}</b> 个模块</span>
        <span>平均完整度 <b>{gov.averageCompleteness}%</b></span>
        <span><b>{gov.pendingReview?.length ?? 0}</b> 个待审核</span>
        {gov.bySource?.map((s: any) => <span key={s.source}>{s.source}: <b>{s.count}</b></span>)}
      </div>
      <div className="grid cols-2" style={{ alignItems: "start" }}>
        <div className="card">
          <h3>待审核（DRAFT）</h3>
          {(gov.pendingReview || []).map((p: any) => (
            <div key={p.id} className="req-item" style={{ alignItems: "center" }}>
              <span className="rid">{p.id}</span><span>{p.name}<span className="chip" style={{ marginLeft: 6 }}>{p.source}</span></span>
              <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                <button className="btn sm ok" onClick={() => onReview(p.id, "approved")}>通过</button>
                <button className="btn ghost sm" onClick={() => onReview(p.id, "rejected")}>驳回</button>
              </span>
            </div>
          ))}
          {!gov.pendingReview?.length && <p className="hint">没有待审核模块。</p>}
        </div>
        <div className="card">
          <h3>低完整度名单（&lt;60 分）</h3>
          {(gov.lowCompleteness || []).map((l: any) => (
            <div key={l.id} className="req-item">
              <span className="rid">{l.score}</span>
              <span><b>{l.name}</b><br /><span className="hint">缺：{l.missing.join("、")}</span></span>
            </div>
          ))}
          {!gov.lowCompleteness?.length && <p className="hint">全部达标 ✓</p>}
        </div>
      </div>
    </div>
  );
}


/* ============ 硬件版本记录（module_revisions 独立表）============ */
function RevisionSection({ moduleId }: { moduleId: string }) {
  const [revs, setRevs] = useState<any[]>([]);
  const [form, setForm] = useState({ revision_code: "", identified_chip: "", changes: "" });
  const load = useCallback(() => {
    fetch(`/api/modules/${moduleId}/revisions`).then((r) => r.json()).then((d) => setRevs(d.revisions || []));
  }, [moduleId]);
  useEffect(() => { load(); }, [load]);
  async function add() {
    if (!form.revision_code) return;
    await fetch(`/api/modules/${moduleId}/revisions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form),
    });
    setForm({ revision_code: "", identified_chip: "", changes: "" });
    load();
  }
  return (
    <section>
      <h4>硬件版本记录 <span className="hint" style={{ fontWeight: 400 }}>同一淘宝商品可能换板换芯片，逐版记录</span></h4>
      {revs.map((r) => (
        <div key={r.revision_id} className="req-item">
          <span className="rid">{r.revision_code}</span>
          <span>{r.identified_chip && <b>{r.identified_chip} · </b>}{r.changes || "—"}
            <span className="hint">（{String(r.created_at).slice(0, 10)}）</span></span>
        </div>
      ))}
      <div className="ef-grid" style={{ gridTemplateColumns: "0.6fr 0.8fr 1.6fr auto", alignItems: "end", marginTop: 8 }}>
        <F label="版本号"><input value={form.revision_code} placeholder="V2.1" onChange={(e) => setForm({ ...form, revision_code: e.target.value })} /></F>
        <F label="实测芯片"><input value={form.identified_chip} placeholder="丝印/实测型号" onChange={(e) => setForm({ ...form, identified_chip: e.target.value })} /></F>
        <F label="变化说明"><input value={form.changes} placeholder="换用国产替代芯片，引脚兼容但阈值不同" onChange={(e) => setForm({ ...form, changes: e.target.value })} /></F>
        <button className="btn sm" onClick={add}>记录</button>
      </div>
    </section>
  );
}
