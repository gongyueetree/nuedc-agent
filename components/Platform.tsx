"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { callAgent, api, getEmbedParams, emitToEzplm, pollTask, cancelActiveTask } from "./api";
import { HomePage, ModulesPage, ProjectsPage } from "./pages-core";
import { SolutionPage, WiringPage, CodePage, DebugPage, ReportPage } from "./pages-build";
import { BomPage, TestingPage } from "./pages-work";

export const STAGES = [
  "PREPARATION","PROBLEM_RECEIVED","REQUIREMENTS_PARSED","SOLUTION_CANDIDATES","SOLUTION_APPROVED",
  "BOM_CONFIRMED","HARDWARE_BUILD","SOFTWARE_BUILD","INTEGRATION","TESTING","OPTIMIZATION","REPORTING","SUBMITTED",
] as const;
export const STAGE_LABEL: Record<string, string> = {
  PREPARATION:"备赛", PROBLEM_RECEIVED:"拿题", REQUIREMENTS_PARSED:"需求解析", SOLUTION_CANDIDATES:"候选方案",
  SOLUTION_APPROVED:"方案确认", BOM_CONFIRMED:"BOM确认", HARDWARE_BUILD:"硬件搭建", SOFTWARE_BUILD:"软件开发",
  INTEGRATION:"联调", TESTING:"测试", OPTIMIZATION:"优化", REPORTING:"报告", SUBMITTED:"提交",
};

const NAV = [
  { key: "home",     label: "首页",     icon: "🏠" },
  { key: "solution", label: "方案生成", icon: "🧠" },
  { key: "wiring",   label: "电路连线", icon: "🔌" },
  { key: "bom",      label: "物料清单", icon: "📦" },
  { key: "code",     label: "代码生成", icon: "⌨️" },
  { key: "debug",    label: "调试助手", icon: "🔬" },
  { key: "testing",  label: "测试评分", icon: "🧪" },
  { key: "report",   label: "报告生成", icon: "📄" },
  // 以下两项不属于备赛流程，入口放在顶栏：
  // 电赛模块是可随时查阅的资料库，我的项目是项目管理
  { key: "modules",  label: "电赛模块", icon: "🔲" },
  { key: "projects", label: "我的项目", icon: "📁" },
] as const;

/** 参与流程导航的页面（左侧栏与工作流标签）。
 *  projects 是项目管理入口而非流程步骤，放在顶栏。 */
const FLOW_NAV = NAV.filter((n) => !["projects", "modules"].includes(n.key));
export type PageKey = (typeof NAV)[number]["key"];
const PAGE_TITLE: Record<PageKey, string> = {
  home: "首页", solution: "方案生成", modules: "电赛模块",
  wiring: "电路连线与接口检查", bom: "物料清单（BOM 工作台）", code: "代码生成",
  debug: "调试助手（LabSight）", testing: "测试与评分",
  report: "报告生成", projects: "我的项目",
};

export interface Msg { who: "user" | "agent"; text: string }

export default function Platform({ embed }: { embed: boolean }) {
  const params = useMemo(getEmbedParams, []);
  const [page, setPage] = useState<PageKey>("home");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<any[]>([]);
  const reloadProjects = useCallback(() => {
    api("/api/projects").then((d) => setProjects(d.projects || []));
  }, []);
  const [stage, setStage] = useState<string>("PREPARATION");
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([
    { who: "agent", text: "你好，我是电赛设计助手。把赛题原文粘贴给我，或点击下方典型方向快速开始 —— 我会先帮你把题目拆成可核对的指标清单，确认后再生成方案。" },
  ]);

  // 项目内产物（跨页共享）
  const [problemText, setProblemText] = useState("");
  const [requirements, setRequirements] = useState<any>(null);
  const [solutions, setSolutions] = useState<any>(null);
  const [chosenSolution, setChosenSolution] = useState<any>(null);
  const [wiringReport, setWiringReport] = useState<any>(null);
  const [bom, setBom] = useState<any>(null);
  const [codeBundle, setCodeBundle] = useState<any>(null);
  const [debugSession, setDebugSession] = useState<any>(null);
  const [report, setReport] = useState<any>(null);
  const [modules, setModules] = useState<any[]>([]);
  const [backupSolution, setBackupSolution] = useState<any>(null);   // 备用方案
  const [testPlan, setTestPlan] = useState<any>(null);
  const [testRecords, setTestRecords] = useState<any[]>([]);
  const [testResult, setTestResult] = useState<any>(null);           // verdicts + summary
  const [staleTypes, setStaleTypes] = useState<string[]>([]);        // 方案变更后过期的产物类型
  const [sysMode, setSysMode] = useState<any>(null);                 // 系统模式与排队情况
  const [progress, setProgress] = useState<any>(null);               // 当前任务排队位置
  const [shortlist, setShortlist] = useState<string[]>([]); // 电赛模块页「选用」的备选模块

  const say = useCallback((who: Msg["who"], text: string) => {
    setMsgs((m) => [...m, { who, text }]);
  }, []);

  // ---- 初始加载：项目列表 + 模块库 ----
  // 系统模式轮询（降级时页面给出明确提示，不白屏）
  useEffect(() => {
    const load = () => api("/api/admin/system-mode").then((d) => { if (!d.error) setSysMode(d); }).catch(() => {});
    load();
    // 2 分钟一次即可 —— 降级提示不需要秒级实时，而每次轮询都要查库，
    // 30 秒一次一天近 3000 次请求，会明显消耗数据库传输配额。
    // 标签页不可见时停止轮询（挂着不用的页面不该继续烧配额）。
    let t: any = setInterval(load, 120_000);
    const onVis = () => {
      if (document.hidden) { clearInterval(t); t = null; }
      else if (!t) { load(); t = setInterval(load, 120_000); }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => { if (t) clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  useEffect(() => {
    reloadProjects();
    api(`/api/modules?tier=${params.tier}`).then((d) => setModules(d.modules || [])).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!projectId) return;
    api(`/api/projects/${projectId}`).then(async (d) => {
      if (d.error) { say("agent", `项目加载失败：${d.error}`); return; }
      if (d.project) {
        setStage(String(d.project.stage));
        if (d.project.problem_text) setProblemText(String(d.project.problem_text));
      }
      // 从每类最新产物全量恢复（刷新不丢工作）
      const L: Record<string, any> = {};
      for (const a of d.latest || []) L[a.type] = a;
      if (L.requirements) setRequirements(L.requirements.content);
      if (L.solution_proposal) setSolutions(L.solution_proposal.content);
      if (L.solution) setChosenSolution(L.solution.content);
      if (L.bom) setBom(L.bom.content);
      if (L.integration_report) setWiringReport(L.integration_report.content);
      if (L.code_bundle) setCodeBundle(L.code_bundle.content);
      if (L.test_plan) setTestPlan(L.test_plan.content);
      if (L.test_record) setTestRecords(L.test_record.content?.records || []);
      if (L.score) setTestResult(L.score.content);
      if (L.report) setReport(L.report.content);
      // 只有"确实存在且被标记 stale"的产物类型才进入横幅列表
      setStaleTypes((d.latest || []).filter((a: any) => a.status === "stale" && a.content).map((a: any) => a.type));
      // 活动任务续跑：刷新页面不中断
      const t = await api(`/api/agent-tasks?project_id=${projectId}&active=1`);
      const task = t.tasks?.[0];
      if (task) {
        say("agent", `检测到未完成的任务（${task.agent_type}），继续等待结果……`);
        setBusy(true);
        const r: any = await pollTask(String(task.task_id), task.status === "queued");
        setBusy(false);
        if (r.ok) {
          if (r.agent === "solution_architect") setSolutions(r.output);
          if (r.agent === "code_generator") setCodeBundle(r.output);
          if (r.agent === "report_composer") setReport(r.output);
          say("agent", "此前的任务已完成，结果已就位。");
        } else say("agent", `此前的任务未成功：${r.message || ""}`);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // ---- ezPLM → 智能体 消息桥 ----
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!e.data?.__ezplm) return;
      if (e.data.type === "set_problem") { setProblemText(String(e.data.payload || "")); setPage("solution"); }
      if (e.data.type === "set_project") setProjectId(String(e.data.payload || "") || null);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  async function ensureProject(seedProblem?: string): Promise<string> {
    if (projectId) return projectId;
    const d = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "电赛项目 " + new Date().toLocaleDateString(),
        problem_text: seedProblem || problemText,
        ezplm_project_id: params.ezplmProjectId,
      }),
    });
    setProjectId(d.project_id);
    reloadProjects();
    return d.project_id;
  }

  async function advanceStage(to: string, pid?: string) {
    const id = pid || projectId;
    if (!id) return;
    await api(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify({ stage: to }) });
    setStage(to);
    emitToEzplm("stage_changed", { project_id: id, stage: to });
  }

  function resetProject() {
    setProjectId(null); setStage("PREPARATION"); setProblemText("");
    setRequirements(null); setSolutions(null); setChosenSolution(null); setBackupSolution(null);
    setWiringReport(null); setBom(null); setCodeBundle(null); setDebugSession(null); setReport(null);
    setTestPlan(null); setTestRecords([]); setTestResult(null); setStaleTypes([]);
    setShortlist([]);
    setMsgs((m) => m.slice(0, 1));
  }

  // ============ Agent 动作 ============

  /** 赛题解析：对话式入口（方案生成页） */
  async function runInterpret(text: string) {
    const t = (text || problemText).trim();
    if (!t) { say("agent", "请先粘贴赛题原文或描述设计需求。"); return; }
    setProblemText(t);
    setBusy(true);
    say("user", t.length > 160 ? t.slice(0, 160) + "…" : t);
    let r: any, pid: string | null = null;
    try {
      pid = await ensureProject(t);
      if (!pid) { say("agent", "项目创建失败，请检查数据库连接后重试。"); return; }
      await api(`/api/projects/${pid}`, { method: "PATCH", body: JSON.stringify({ problem_text: t, stage: "PROBLEM_RECEIVED" }) });
      setStage("PROBLEM_RECEIVED");
      r = await callAgent("problem_interpreter", { problem_text: t }, pid);
    } finally { setBusy(false); }
    if (r.ok) {
      setRequirements(r.output);
      const amb = r.output?.ambiguities?.length || 0;
      say("agent", `已把题目拆成 ${r.output?.requirements?.length ?? 0} 条可核对指标（见右侧）。` +
        (amb ? `其中 ${amb} 处题面有歧义，我按常规理解做了标注，请核对。` : "") +
        `\n确认无误后点「生成方案」，我会给出一套完整方案（含框图与接口预检）；需要对比论证时可再生成备选。`);
      await advanceStage("REQUIREMENTS_PARSED", pid || undefined);
      emitToEzplm("requirements_ready", r.output);
    } else say("agent", "解析失败：" + (r.message || ""));
  }

  // ============ 需求编辑器动作 ============
  function updateRequirement(id: string, patch: any) {
    setRequirements((rq: any) => ({
      ...rq,
      requirements: (rq.requirements || []).map((r: any) => r.id === id ? { ...r, ...patch } : r),
    }));
  }
  function setReqStatus(id: string, status: string) {
    updateRequirement(id, { status, confirmed_at: status === "CONFIRMED" ? new Date().toISOString() : undefined });
  }
  function confirmAllExtracted() {
    setRequirements((rq: any) => ({
      ...rq,
      requirements: (rq.requirements || []).map((r: any) =>
        !r.status || r.status === "AI_EXTRACTED" ? { ...r, status: "CONFIRMED", confirmed_at: new Date().toISOString() } : r),
    }));
  }
  function addRequirement() {
    setRequirements((rq: any) => {
      const list = rq?.requirements || [];
      const nextId = "REQ-" + String(list.length + 1).padStart(3, "0") + "M";
      return { ...(rq || {}), requirements: [...list, {
        id: nextId, type: "functional", description: "", priority: "mandatory",
        source: "人工补充", verification_method: "measurement", status: "CONFIRMED",
        confirmed_at: new Date().toISOString(),
      }] };
    });
  }

  // 需求编辑持久化（1.5s 防抖存为新版本）
  useEffect(() => {
    if (!projectId || !requirements) return;
    const t = setTimeout(() => {
      api(`/api/projects/${projectId}/artifacts`, { method: "POST", body: JSON.stringify({ type: "requirements", content: requirements }) });
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requirements]);

  const DOWNSTREAM = ["integration_report", "bom", "procurement_plan", "code_bundle", "code_verification", "test_plan", "test_record", "score", "test_report", "report"];
  async function persistSolution(sol: any) {
    if (!projectId) return;
    await api(`/api/projects/${projectId}/artifacts`, { method: "POST", body: JSON.stringify({ type: "solution", content: sol }) });
    setStaleTypes(DOWNSTREAM);   // 服务端已级联标记，本地同步横幅
  }
  function unstale(...types: string[]) { setStaleTypes((s) => s.filter((t) => !types.includes(t))); }

  // ============ 方案编辑动作 ============
  async function replaceBlock(solutionId: string, blockId: string, mod: any) {
    const apply = (sol: any) => sol.solution_id !== solutionId ? sol : {
      ...sol,
      blocks: sol.blocks.map((b: any) => b.block_id === blockId
        ? { ...b, module_id: mod.id, name: mod.name.length > 14 ? mod.name.slice(0, 14) : mod.name }
        : b),
      integration_precheck: undefined,   // 改动后预检失效
    };
    let updated: any = null;
    setSolutions((ss: any) => {
      if (!ss) return ss;
      const next = { ...ss, solutions: ss.solutions.map(apply) };
      updated = next.solutions.find((x: any) => x.solution_id === solutionId);
      return next;
    });
    setChosenSolution((c: any) => (c?.solution_id === solutionId ? apply(c) : c));
    setBackupSolution((c: any) => (c?.solution_id === solutionId ? apply(c) : c));
    // 改动后立刻重跑接口检查（规则引擎，快）
    setBusy(true);
    const target = updated || (chosenSolution?.solution_id === solutionId ? apply(chosenSolution) : null);
    if (target) {
      const r = await callAgent("integration_checker", { solution: target }, projectId);
      if (r.ok) {
        const attach = (sol: any) => sol.solution_id === solutionId ? { ...sol, integration_precheck: r.output } : sol;
        setSolutions((ss: any) => ss ? { ...ss, solutions: ss.solutions.map(attach) } : ss);
        setChosenSolution((c: any) => c ? attach(c) : c);
        setBackupSolution((c: any) => c ? attach(c) : c);
        if (chosenSolution?.solution_id === solutionId) { setWiringReport(r.output); unstale("integration_report"); }
        if (target && chosenSolution?.solution_id === solutionId) persistSolution({ ...target, integration_precheck: r.output });
        say("agent", `已把模块替换为「${mod.name}」并重跑接口检查：${r.output.passed ? "通过 ✓" : `发现 ${r.output.issues.filter((i: any) => i.severity === "blocker").length} 个阻断项`}`);
      }
    }
    setBusy(false);
  }
  function markBackup(sol: any) {
    setBackupSolution(sol);
    say("agent", `已将 ${sol.solution_id}「${sol.name}」标记为备用方案。主方案受阻时可一键切换。`);
  }
  function swapToBackup() {
    if (!backupSolution) return;
    const prev = chosenSolution;
    setChosenSolution(backupSolution);
    setBackupSolution(prev);
    setWiringReport(backupSolution.integration_precheck || null);
    say("agent", `已切换到备用方案 ${backupSolution.solution_id}。原主方案转为备用。`);
  }

  /** 为采用官方题目准备项目（无项目时新建），返回 projectId */
  async function ensureProjectForProblem(): Promise<string | null> {
    if (projectId) return projectId;
    const r = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "电赛项目" }) });
    if (r.project_id) { setProjectId(r.project_id); reloadProjects(); return r.project_id; }
    return null;
  }

  /** 重新载入项目产物（采用官方题目后刷新需求清单） */
  async function reloadProject(pid?: string | null) {
    const id = pid || projectId;
    if (!id) return;
    const d = await api(`/api/projects/${id}`);
    const L: Record<string, any> = {};
    for (const a of d.latest || []) L[a.type] = a;
    if (L.requirements) setRequirements(L.requirements.content);
    if (d.project?.stage) setStage(String(d.project.stage));
  }

  // 框图节点手动摆位持久化（随方案产物一起存）
  async function saveLayout(solutionId: string, layout: Record<string, { x: number; y: number }>) {
    const apply = (sol: any) => (sol?.solution_id === solutionId ? { ...sol, layout } : sol);
    setSolutions((ss: any) => ss ? { ...ss, solutions: (ss.solutions || ss.candidate_solutions || []).map(apply) } : ss);
    setChosenSolution((c: any) => {
      const next = apply(c);
      if (c?.solution_id === solutionId && projectId) {
        api(`/api/projects/${projectId}/artifacts`, { method: "POST", body: JSON.stringify({ type: "solution", content: next }) });
      }
      return next;
    });
  }

  // ============ 电源树编辑（修复电源类阻断项的正道）============
  async function updatePowerRail(railName: string, patch: any) {
    if (!chosenSolution) return;
    const next = {
      ...chosenSolution,
      power_tree: (chosenSolution.power_tree || []).map((r: any) =>
        r.rail === railName ? { ...r, ...patch } : r),
      integration_precheck: undefined,
    };
    setChosenSolution(next);
    setBusy(true);
    const r = await callAgent("integration_checker", { solution: next }, projectId);
    setBusy(false);
    if (r.ok) {
      setWiringReport(r.output);
      const withCheck = { ...next, integration_precheck: r.output };
      setChosenSolution(withCheck);
      persistSolution(withCheck);
      unstale("integration_report");
      const blockers = (r.output.issues || []).filter((i: any) => i.severity === "blocker").length;
      say("agent", blockers
        ? `电源轨 ${railName} 已更新，仍有 ${blockers} 个阻断项待处理。`
        : `电源轨 ${railName} 已更新，检查全部通过 ✓ 现在可以进入代码生成。`);
    }
  }

  // ============ 测试评分动作 ============
  async function runTestPlan() {
    if (!requirements) return { ok: false, message: "请先完成需求确认" } as any;
    setBusy(true);
    if (projectId && ["BOM_CONFIRMED", "HARDWARE_BUILD", "SOFTWARE_BUILD", "INTEGRATION"].includes(stage)) await advanceStage("TESTING");
    const r = await callAgent("test_scoring", { requirements, records: testRecords, project_id_for_artifacts: projectId }, projectId);
    setBusy(false);
    if (r.ok) { setTestPlan(r.output.plan); setTestResult(r.output); unstale("test_plan", "test_report", "score"); }
    return r;
  }
  async function runScore(records: any[]) {
    setTestRecords(records);
    setBusy(true);
    const r = await callAgent("test_scoring", { requirements, records, existing_plan: testPlan, generate_plan: false, project_id_for_artifacts: projectId }, projectId);
    setBusy(false);
    if (r.ok) { setTestResult(r.output); unstale("test_record", "score"); }
    return r;
  }

  // ============ 代码验证动作 ============
  async function runVerify() {
    if (!codeBundle?.files?.length) return { ok: false, message: "请先生成代码" } as any;
    setBusy(true);
    const r = await callAgent("code_verifier", { files: codeBundle.files }, projectId);
    setBusy(false);
    if (r.ok) setCodeBundle((b: any) => ({ ...b, verification_status: r.output.verification_status, verify_issues: r.output.issues, honest_note: r.output.honest_note }));
    return r;
  }

  async function runSolution(variant?: "safe" | "performance") {
    if (!requirements) { say("agent", "请先把赛题发给我完成需求解析。"); return; }
    setBusy(true);
    const existing = (solutions?.solutions || solutions?.candidate_solutions || []) as any[];
    const isAlt = !!variant && existing.length > 0;
    say("user", isAlt ? `生成备选方案（${variant === "safe" ? "稳妥优先" : "性能优先"}）` : "生成方案");
    say("agent", isAlt
      ? "正在生成一套技术路线不同的备选方案，用于对比论证……"
      : "正在设计方案（含框图与接口预检），通常需要 30~60 秒，请稍候……");
    const r = await callAgent("solution_architect", {
      requirements,
      preferred_modules: shortlist.length ? shortlist : undefined,
      variant,
      existing_solutions: isAlt ? existing : undefined,
    }, projectId, (p) => setProgress(p));
    setBusy(false); setProgress(null);
    if (r.ok) {
      setSolutions(r.output);
      const list = r.output?.solutions || r.output?.candidate_solutions || [];
      say("agent", isAlt
        ? `已追加备选方案（现有 ${list.length} 套），可对比后选定主方案。`
        : "方案已生成（含框图与接口预检）。请核对后点「采用为主方案」；如需对比论证，可再生成一套备选。");
      if (projectId) await advanceStage("SOLUTION_CANDIDATES");
    } else if ((r as any).degraded) {
      say("agent", (r as any).degraded.reason);
    } else {
      // 学生端不暴露 Key、连通性、内部诊断接口这类运维措辞（学生测试反馈 P1-5）
      const detail = String(r.message || "");
      const serviceIssue = /LLM|模型|运行失败|HTTP 5|超时|timeout|unavailable/i.test(detail);
      say("agent", serviceIssue
        ? "生成失败：服务暂时不可用。\n\n你的需求已保存，稍后点「生成方案」重试即可，无需重新粘贴赛题。\n若持续失败请联系指导老师。"
        : `生成失败：${detail || "请稍后重试"}`);
    }
  }

  async function approveSolution(sol: any) {
    setChosenSolution(sol);
    persistSolution(sol);
    const pre = sol.integration_precheck;
    say("agent", `已确认方案 ${sol.solution_id}「${sol.name}」。接口预检${pre?.passed ? "通过 ✓" : `发现 ${pre?.issues?.filter((i: any) => i.severity === "blocker").length ?? 0} 个阻断项`}` +
      (pre?.passed ? "，可以进入模块 BOM 和代码生成。" : "，请到「电路连线」页处理后再进代码生成。"));
    if (projectId) await advanceStage("SOLUTION_APPROVED");
    emitToEzplm("solution_approved", { solution_id: sol.solution_id });
  }

  async function runWiringCheck() {
    if (!chosenSolution) return null;
    setBusy(true);
    const r = await callAgent("integration_checker", { solution: chosenSolution }, projectId);
    setBusy(false);
    if (r.ok) { setWiringReport(r.output); unstale("integration_report"); }
    return r;
  }

  async function runBomFromSolution() {
    if (!chosenSolution) { say("agent", "请先在「方案生成」页确认一套方案。"); return { ok: false, message: "尚未确认方案" } as any; }
    setBusy(true);
    const r = await callAgent("bom_agent", { solution: chosenSolution }, projectId);
    setBusy(false);
    if (r.ok) {
      setBom(r.output);
      unstale("bom", "procurement_plan");
      if (projectId) await advanceStage("BOM_CONFIRMED");
      emitToEzplm("bom_ready", r.output);
    } else say("agent", `BOM 生成失败：${r.message || ""}`);
    return r;
  }

  async function runBomFromText(raw: string) {
    setBusy(true);
    const r = await callAgent("bom_agent", { raw_bom: raw }, projectId);
    setBusy(false);
    if (r.ok) { setBom(r.output); emitToEzplm("bom_ready", r.output); }
    return r;
  }

  async function runCode(target: string) {
    if (!chosenSolution) return { ok: false, message: "代码生成需要已确认的方案（状态门禁）" } as any;
    const pre = wiringReport || chosenSolution.integration_precheck;
    if (pre && !pre.passed) return { ok: false, message: "接口检查存在阻断项，禁止进入代码生成 —— 请先到「电路连线」页处理" } as any;
    setBusy(true);
    if (projectId && stage === "SOLUTION_APPROVED") await advanceStage("BOM_CONFIRMED");
    const r = await callAgent("code_generator", { solution: chosenSolution, target_module: target }, projectId);
    setBusy(false);
    if (r.ok) { setCodeBundle(r.output); unstale("code_bundle", "code_verification"); }
    return r;
  }

  async function runDebug(symptom: string, logs: string, images: { media_type: string; data_base64: string }[]) {
    setBusy(true);
    const r = await callAgent("labsight_debug", {
      symptom, logs, images: images.length ? images : undefined,
      context: { solution: chosenSolution?.name },
      history: debugSession ? [debugSession] : [],
    }, projectId);
    setBusy(false);
    if (r.ok) setDebugSession(r.output);
    return r;
  }

  async function runReport(opts: { includeBom: boolean; includeCode: boolean; includeDebug: boolean }) {
    if (!chosenSolution) return { ok: false, message: "报告必须基于已确认方案生成（请先完成方案确认）" } as any;
    setBusy(true);
    if (projectId) await advanceStage("REPORTING");
    const r = await callAgent("report_composer", {
      requirements,
      solution: chosenSolution,
      bom: opts.includeBom ? bom : null,
      code_files: opts.includeCode ? codeBundle?.files?.map((f: any) => f.path) : null,
      test_results: null,
      debug_notes: opts.includeDebug && debugSession ? [debugSession.symptom] : [],
    }, projectId);
    setBusy(false);
    if (r.ok) { setReport(r.output); unstale("report"); emitToEzplm("report_ready", { project_id: projectId }); }
    return r;
  }

  /** 方案页对话：长文本视为赛题；已有需求后的短文本走总控 */
  async function chat(text: string) {
    const t = text.trim();
    if (!t) return;
    if (!requirements && t.length > 60) return runInterpret(t);
    say("user", t);
    setBusy(true);
    const r = await callAgent("orchestrator", { user_request: t, context: { stage, has_requirements: !!requirements, has_solution: !!chosenSolution } }, projectId);
    setBusy(false);
    if (r.ok) {
      const o = r.output;
      say("agent", (o.reply || "") + (o.tasks?.length ? "\n\n建议步骤：\n" + o.tasks.map((tk: any) => `· ${tk.task}`).join("\n") : ""));
    } else say("agent", r.message || "调用失败");
  }

  function startFromDirection(seed: string) {
    // 从首页方向卡进入 = 开一个全新项目，必须先清空上一个项目的全部状态
    resetProject();
    setPage("solution");
    setTimeout(() => runInterpret(seed), 0);   // 等状态清空后再发起解析
  }

  const stageIdx = STAGES.indexOf(stage as any);
  const ctx = {
    params, busy, stage, stageIdx, projectId, projects, setProjectId, resetProject, reloadProjects,
    problemText, setProblemText, requirements, solutions, chosenSolution,
    wiringReport, bom, codeBundle, debugSession, report, modules, shortlist, setShortlist,
    backupSolution, testPlan, testRecords, testResult, staleTypes, sysMode, progress,
    msgs, chat, runInterpret, runSolution, approveSolution, runWiringCheck,
    runBomFromSolution, runBomFromText, runCode, runDebug, runReport, startFromDirection,
    updateRequirement, setReqStatus, confirmAllExtracted, addRequirement,
    replaceBlock, markBackup, swapToBackup, runTestPlan, runScore, runVerify, updatePowerRail, saveLayout,
    ensureProjectForProblem, reloadProject,
    setReport, setPage, advanceStage,
  };

  return (
    <div className={"shell" + (embed ? " embed" : "")}>
      <aside className="sidebar">
        <div className="logo">
          <div className="mark">电</div>
          <div><b>电赛智能体</b><small>NUEDC AGENT</small></div>
        </div>
        {FLOW_NAV.map((n) => (
          <button key={n.key} className={"navitem" + (page === n.key ? " active" : "")} onClick={() => setPage(n.key)}>
            <span className="ic">{n.icon}</span>{n.label}
          </button>
        ))}
        <div className="promo">
          <b>2026 电赛备战</b>
          <p>方案 + 代码 + 调试 + 报告<br />一站式备赛</p>
          <div className="stage-mini" title={`当前阶段：${STAGE_LABEL[stage]}`}>
            {STAGES.map((s, i) => <i key={s} className={i <= stageIdx ? "on" : ""} />)}
          </div>
        </div>
      </aside>

      <div className="workarea">
        <header className="topbar">
          <h1>{PAGE_TITLE[page]}</h1>
          <span className="crumb">
            {busy && (
              <>
                <span className="spinner" />
                {progress?.queue?.ahead > 0
                  ? ` 排队中（前面 ${progress.queue.ahead} 个任务，预计 ${Math.max(1, Math.round(progress.queue.estimated_wait_seconds / 60))} 分钟）`
                  : " 智能体运行中…"}
                <button className="btn ghost sm" onClick={() => cancelActiveTask()}>取消</button>
              </>
            )}
          </span>
          <select value={projectId || ""} onChange={(e) => setProjectId(e.target.value || null)} aria-label="选择项目">
            <option value="">— 选择项目 —</option>
            {projects.map((p) => <option key={p.project_id} value={p.project_id}>{p.name}</option>)}
          </select>
          <span className="stagepill">{STAGE_LABEL[stage] || stage}</span>
          <button className={"btn ghost sm" + (page === "modules" ? " on" : "")}
            onClick={() => setPage("modules")} title="浏览电赛模块库，可随时选用到当前方案">🔲 电赛模块</button>
          <button className={"btn ghost sm" + (page === "projects" ? " on" : "")}
            onClick={() => setPage("projects")} title="查看与管理全部项目">📁 我的项目</button>
          <button className="btn ghost sm" onClick={resetProject}>新建项目</button>
        </header>

        {page !== "home" && (
          <nav className="worktabs" aria-label="工作流程">
            {FLOW_NAV.filter((n) => n.key !== "home").map((n) => (
              <button key={n.key} className={page === n.key ? "active" : ""} onClick={() => setPage(n.key)}>
                <span className="ic">{n.icon}</span>{n.label}
              </button>
            ))}
          </nav>
        )}

        <div className="page">
          {page === "home" && <HomePage ctx={ctx} />}
          {page === "solution" && <SolutionPage ctx={ctx} />}
          {page === "modules" && <ModulesPage ctx={ctx} />}
          {page === "wiring" && <WiringPage ctx={ctx} />}
          {page === "bom" && <BomPage ctx={ctx} />}
          {page === "code" && <CodePage ctx={ctx} />}
          {page === "debug" && <DebugPage ctx={ctx} />}
          {page === "testing" && <TestingPage ctx={ctx} />}
          {page === "report" && <ReportPage ctx={ctx} />}
          {page === "projects" && <ProjectsPage ctx={ctx} />}
        </div>
      </div>
    </div>
  );
}
