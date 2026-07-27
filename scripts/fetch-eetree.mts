/** eetree 赛题数据探测与导出。
 *
 *  用途：eetree 是自有产品，但若一时拿不到数据库/API 文档，
 *  可用本脚本先探测页面结构，确认数据在哪，再批量导出成
 *  import-problems 能吃的 manifest 格式。
 *
 *  ⚠ 前提：仅用于自有站点。抓取他人站点请先获得授权。
 *
 *  推荐仍是从数据库直接导出 —— 页面抓取依赖 DOM 结构，改版即失效。
 *
 *  用法：
 *    1) 探测单页，看看数据长什么样
 *       npx tsx scripts/fetch-eetree.mts probe https://www.eetree.cn/task/873
 *
 *    2) 探测列表页，找出题目链接规律
 *       npx tsx scripts/fetch-eetree.mts probe-list https://www.eetree.cn/nuedc
 *
 *    3) 按探测结果批量导出（确认选择器后再跑）
 *       npx tsx scripts/fetch-eetree.mts export ids.txt out.json
 *
 *  环境变量：
 *    EETREE_BASE      站点根地址，默认 https://www.eetree.cn
 *    EETREE_COOKIE    需要登录才能看的内容时提供
 *    FETCH_DELAY_MS   请求间隔，默认 1200ms（对自家服务器也别太猛）
 */
import { readFileSync, writeFileSync } from "node:fs";

const BASE = (process.env.EETREE_BASE || "https://www.eetree.cn").replace(/\/+$/, "");
const DELAY = Number(process.env.FETCH_DELAY_MS || 1200);
const COOKIE = process.env.EETREE_COOKIE || "";

const cmd = process.argv[2];
const argA = process.argv[3];
const argB = process.argv[4];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string): Promise<{ status: number; body: string; contentType: string }> {
  const res = await fetch(url, {
    headers: {
      "user-agent": "nuedc-agent-importer/1.0 (self-hosted content sync)",
      accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      ...(COOKIE ? { cookie: COOKIE } : {}),
    },
  });
  return {
    status: res.status,
    body: await res.text(),
    contentType: res.headers.get("content-type") || "",
  };
}

/** 解析 eetree 的页面标题。
 *  实测格式：2025年_A题：能量回馈的变流器负载试验装置（本科组）
 *  年份、题号、标题、组别四项齐全，无需再从正文推断。 */
export function parseEetreeTitle(raw: string): {
  year: number; code: string; title: string; group?: string;
} | null {
  const t = raw.replace(/\s+/g, " ").trim();
  const m = t.match(/^(\d{4})\s*年[_\s-]*([A-Z]\d?)\s*题[：:]\s*(.+?)(?:（(.+?)）|\((.+?)\))?\s*$/);
  if (!m) return null;
  return {
    year: Number(m[1]),
    code: m[2].toUpperCase(),
    title: m[3].trim(),
    group: (m[4] || m[5] || "").trim() || undefined,
  };
}

/** 从 HTML 里挖出可能承载数据的位置 */
function analyze(html: string) {
  const findings: string[] = [];

  // Next.js / Nuxt / 通用 SSR 数据岛
  const dataIslands: [string, RegExp][] = [
    ["Next.js __NEXT_DATA__", /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/],
    ["Nuxt __NUXT__", /window\.__NUXT__\s*=\s*([\s\S]*?)<\/script>/],
    ["通用 __INITIAL_STATE__", /window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/],
    ["JSON-LD", /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/],
  ];
  for (const [name, re] of dataIslands) {
    const m = html.match(re);
    if (m) {
      findings.push(`✓ 发现 ${name}（${m[1].length} 字符）`);
      try {
        const json = JSON.parse(m[1].trim().replace(/;$/, ""));
        findings.push(`  顶层键：${Object.keys(json).slice(0, 12).join(", ")}`);
      } catch {
        findings.push("  （不是纯 JSON，可能是函数包裹的状态）");
      }
    }
  }

  // 页面里出现的 API 路径，往往就是真正的数据源
  const apis = new Set<string>();
  for (const m of html.matchAll(/["'](\/(?:api|v\d)\/[^"'\s]{3,120})["']/g)) apis.add(m[1]);
  if (apis.size) {
    findings.push(`✓ 页面中出现 ${apis.size} 个 API 路径（很可能是真正的数据接口）：`);
    for (const a of [...apis].slice(0, 15)) findings.push(`  ${a}`);
  }

  // 标题候选
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.trim();
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1]?.replace(/<[^>]+>/g, "").trim();
  if (title) findings.push(`标题标签：${title.slice(0, 80)}`);
  if (h1) findings.push(`H1：${h1.slice(0, 80)}`);

  // 是否为 SPA 空壳
  const textLen = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, "").trim().length;
  findings.push(`去除脚本与标签后的正文长度：${textLen}`);
  if (textLen < 400) {
    findings.push("⚠ 正文极少，页面很可能由前端渲染 —— 应直接调用上面列出的 API，而不是解析 HTML");
  }

  return findings;
}

async function main() {
  if (cmd === "probe") {
    if (!argA) { console.error("用法: probe <详情页 URL>"); process.exit(2); }
    console.log(`探测 ${argA}\n`);
    const r = await get(argA);
    console.log(`HTTP ${r.status} · ${r.contentType}\n`);

    if (r.contentType.includes("json")) {
      console.log("返回的是 JSON，直接就是数据接口：");
      console.log(r.body.slice(0, 1500));
      return;
    }
    for (const line of analyze(r.body)) console.log(line);
    console.log(`\n下一步：把上面的输出贴给我，我据此写字段映射。`);
    console.log(`若列出了 API 路径，优先试它：npx tsx scripts/fetch-eetree.mts probe ${BASE}<API 路径>`);
    return;
  }

  if (cmd === "probe-deep") {
    if (!argA) { console.error("用法: probe-deep <详情页 URL>"); process.exit(2); }
    console.log(`深度探测 ${argA}\n`);
    const r = await get(argA);

    const parsed = parseEetreeTitle(
      r.body.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.trim() || "");
    console.log("标题解析：", parsed ? JSON.stringify(parsed, null, 2) : "未匹配已知格式");
    console.log("");

    // 列出各级标题，看看页面是怎么组织的
    const heads: string[] = [];
    for (const m of r.body.matchAll(/<(h[1-4])[^>]*>([\s\S]{0,120}?)<\/\1>/g)) {
      const text = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (text) heads.push(`${m[1]}: ${text.slice(0, 70)}`);
    }
    console.log(`发现 ${heads.length} 个标题：`);
    for (const h of heads.slice(0, 40)) console.log(`  ${h}`);
    if (heads.length > 40) console.log(`  …还有 ${heads.length - 40} 个`);
    console.log("");

    // 关键区块定位：任务/要求/评分在哪个容器里
    const KEYS = ["任务", "要求", "评分标准", "评审标准", "基本要求", "发挥部分", "说明"];
    console.log("关键词所在的元素：");
    for (const key of KEYS) {
      const idx = r.body.indexOf(key);
      if (idx < 0) { console.log(`  ${key}：未出现`); continue; }
      // 往前找最近的开标签，看它挂在什么容器上
      const before = r.body.slice(Math.max(0, idx - 400), idx);
      const tag = [...before.matchAll(/<(\w+)([^>]*)>/g)].pop();
      const occurrences = r.body.split(key).length - 1;
      console.log(`  ${key}：出现 ${occurrences} 次，最近容器 <${tag?.[1] || "?"}${(tag?.[2] || "").slice(0, 80)}>`);
    }
    console.log("");

    // 正文中出现频率最高的 class，通常就是内容容器
    const classes = new Map<string, number>();
    for (const m of r.body.matchAll(/class=["']([^"']{2,60})["']/g)) {
      for (const c of m[1].split(/\s+/)) {
        if (c.length > 2) classes.set(c, (classes.get(c) || 0) + 1);
      }
    }
    const top = [...classes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    console.log("高频 class（可能的内容容器）：");
    for (const [c, n] of top) console.log(`  ${c} ×${n}`);
    console.log("");

    console.log("把以上输出贴给我，我据此写「任务要求 / 评审标准」的精确提取规则。");
    return;
  }

  if (cmd === "probe-list") {
    if (!argA) { console.error("用法: probe-list <列表页 URL>"); process.exit(2); }
    console.log(`探测列表页 ${argA}\n`);
    const r = await get(argA);
    console.log(`HTTP ${r.status} · ${r.contentType}\n`);

    // 找出题目详情链接的规律
    const links = new Map<string, number>();
    for (const m of r.body.matchAll(/href=["']([^"']*\/(?:task|problem|topic)\/\d+[^"']*)["']/g)) {
      const path = m[1].replace(/^https?:\/\/[^/]+/, "");
      links.set(path, (links.get(path) || 0) + 1);
    }
    if (links.size) {
      console.log(`✓ 发现 ${links.size} 个题目链接，样例：`);
      for (const l of [...links.keys()].slice(0, 10)) console.log(`  ${l}`);
      const ids = [...links.keys()].map((l) => l.match(/\/(\d+)/)?.[1]).filter(Boolean);
      writeFileSync("eetree-ids.txt", ids.join("\n"));
      console.log(`\n已把 ${ids.length} 个 id 写入 eetree-ids.txt`);
    } else {
      console.log("未在 HTML 中发现题目链接，可能是前端渲染。分析结果：\n");
      for (const line of analyze(r.body)) console.log(line);
    }
    return;
  }

  if (cmd === "export") {
    if (!argA) { console.error("用法: export <ids.txt> [out.json]"); process.exit(2); }
    const ids = readFileSync(argA, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
    console.log(`导出 ${ids.length} 道题，请求间隔 ${DELAY}ms…\n`);

    const out: any[] = [];
    for (let i = 0; i < ids.length; i++) {
      const url = `${BASE}/task/${ids[i]}`;
      try {
        const r = await get(url);
        // 这里的字段提取需要按 probe 的结果定制 —— 先保留原始内容供人工确认
        const title = r.body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1]?.replace(/<[^>]+>/g, "").trim()
          || r.body.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.trim() || "";
        out.push({ id: ids[i], sourceUrl: url, title, rawLength: r.body.length });
        console.log(`  [${i + 1}/${ids.length}] ${title.slice(0, 50) || "(未取到标题)"}`);
      } catch (e: any) {
        console.error(`  [${i + 1}/${ids.length}] 失败：${String(e?.message || e).slice(0, 80)}`);
      }
      if (i < ids.length - 1) await sleep(DELAY);
    }
    const file = argB || "eetree-export.json";
    writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`\n已写入 ${file}`);
    console.log("注意：本步骤只抓到标题等表层信息。完整的任务要求与评分标准需要");
    console.log("按 probe 结果定制提取规则 —— 把 probe 输出发我，我来补。");
    return;
  }

  console.log(`eetree 赛题数据探测与导出

  probe <详情页 URL>       探测单页结构，找出数据在哪
  probe-deep <详情页 URL>  深度探测：标题解析 + 区块定位 + 容器识别
  probe-list <列表页 URL>  提取题目 id 列表
  export <ids.txt> [out]   批量导出（需先按 probe 结果定制提取规则）

环境变量：
  EETREE_BASE      默认 ${BASE}
  EETREE_COOKIE    需要登录的内容
  FETCH_DELAY_MS   请求间隔，默认 ${DELAY}ms

⚠ 仅用于自有站点。
建议优先从数据库/API 直接导出 —— 页面抓取依赖 DOM 结构，改版即失效。`);
}

main().catch((e) => { console.error(e); process.exit(1); });
