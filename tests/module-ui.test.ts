import { describe, it, expect } from "vitest";

/** 模块图片渲染与 UI 契约。 */

describe("模块图片渲染", () => {
  it("schema 定义了 images 字段", async () => {
    const { moduleInputSchema } = await import("../lib/module-schema");
    const parsed = moduleInputSchema.parse({
      id: "m1", name: "测试模块", category: "mcu.arm",
      images: ["https://example.com/a.jpg"],
    } as any);
    expect(parsed.images).toEqual(["https://example.com/a.jpg"]);
  });

  it("未提供 images 时默认为空数组（回退到分类图标）", async () => {
    const { moduleInputSchema } = await import("../lib/module-schema");
    const parsed = moduleInputSchema.parse({ id: "m1", name: "x", category: "mcu.arm" } as any);
    expect(parsed.images).toEqual([]);
  });

  it("三处 UI 都渲染 images：首页卡片、模块详情弹窗、框图功能块弹窧", async () => {
    const fs = await import("node:fs");
    const core = fs.readFileSync("components/pages-core.tsx", "utf8");
    const build = fs.readFileSync("components/pages-build.tsx", "utf8");
    // 统一缩略图组件，有图用图、无图回退图标
    expect(core).toContain("export function ModuleThumb");
    expect(core).toContain("const src = (m?.images || [])[0]");
    // 卡片与列表都改用该组件，不再直接写死图标
    expect(core).not.toContain('<div className="thumb">{modIcon(m.category)}</div>');
    // 详情弹窗与框图弹窗都有图片区
    expect(core).toContain("module-gallery");
    expect(build).toContain("module-gallery");
  });

  it("图片加载失败时隐藏而不是显示裂图", async () => {
    const fs = await import("node:fs");
    const core = fs.readFileSync("components/pages-core.tsx", "utf8");
    expect(core).toContain("onError");
    expect(core).toContain('style.display = "none"');
  });

  it("缩略图为正方形容器且图片完整显示不裁切", async () => {
    const fs = await import("node:fs");
    const css = fs.readFileSync("app/globals.css", "utf8");
    expect(css).toContain("aspect-ratio: 1 / 1");
    expect(css).toContain("object-fit: contain");   // contain 而非 cover：不裁切
  });
});

describe("导航与流程", () => {
  it("二期占位导航（仿真验证/实验平台）已移除", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/Platform.tsx", "utf8");
    expect(src).not.toContain("NAV_SOON");
    expect(src).not.toContain("仿真验证");
    expect(src).not.toContain("实验平台");
  });

  it("模块选型的 shortlist 确实传给方案生成", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/Platform.tsx", "utf8");
    expect(src).toContain("preferred_modules: shortlist.length ? shortlist : undefined");
  });

  it("模块选型页说明其为可选步骤，并提供返回方案生成的入口", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/pages-core.tsx", "utf8");
    expect(src).toContain("可选步骤");
    expect(src).toContain('ctx.setPage("solution")');
  });

  it("方案生成页显示当前优先模块清单", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/pages-build.tsx", "utf8");
    expect(src).toContain("已从「模块选型」选用");
  });
});

describe("缩略图高度不得塌陷（回归防护）", () => {
  it("thumb 有明确高度，不依赖会与内联样式冲突的 aspect-ratio", async () => {
    const fs = await import("node:fs");
    const css = fs.readFileSync("app/globals.css", "utf8");
    // 基础高度必须存在
    expect(css).toMatch(/\.mod-card \.thumb \{[\s\S]*?height:\s*74px/);
    // 不能再出现 height:auto + aspect-ratio 的组合（首页卡片曾因此塌成 0 高）
    expect(css).not.toMatch(/\.mod-card \.thumb \{ aspect-ratio: 1 \/ 1; height: auto/);
  });

  it("有图状态用 max-width/max-height 而非强制拉伸", async () => {
    const fs = await import("node:fs");
    const css = fs.readFileSync("app/globals.css", "utf8");
    const block = css.slice(css.indexOf(".thumb.has-img img"));
    expect(block).toContain("max-width: 100%");
    expect(block).toContain("max-height: 100%");
    expect(block).toContain("object-fit: contain");
  });

  it("后台 CMS 提供图片预览与删除", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/AdminClient.tsx", "utf8");
    expect(src).toContain("module-gallery");
    expect(src).toContain("图片无法加载");        // 防盗链时给出可操作提示
  });

  it("种子模块均含 images 字段（避免 undefined 导致渲染分支异常）", async () => {
    const fs = await import("node:fs");
    const mods = JSON.parse(fs.readFileSync("data/seed-modules.json", "utf8"));
    for (const m of mods) expect(Array.isArray(m.images), m.id).toBe(true);
  });
});

describe("依赖与 CI 一致性", () => {
  it("lockfile 与 package.json 依赖完全对应（npm ci 的前提）", async () => {
    const fs = await import("node:fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const root = lock.packages?.[""] || {};
    const locked = { ...(root.dependencies || {}), ...(root.devDependencies || {}) };
    const missing = Object.keys(deps).filter((k) => !(k in locked));
    expect(missing, `lockfile 缺少依赖，npm ci 会失败：${missing.join(", ")}`).toHaveLength(0);
  });

  it("package.json 里用到的脚本命令都已定义", async () => {
    const fs = await import("node:fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    for (const s of ["lint", "typecheck", "test", "build", "verify:docx", "e2e", "load-test", "worker", "db:init"]) {
      expect(pkg.scripts?.[s], `缺少脚本 ${s}`).toBeTruthy();
    }
  });

  it("CI 覆盖 lint/typecheck/test/build 全流程", async () => {
    const fs = await import("node:fs");
    const ci = fs.readFileSync(".github/workflows/ci.yml", "utf8");
    for (const step of ["npm run lint", "npm run typecheck", "npm test", "npm run build"]) {
      expect(ci, `CI 缺少 ${step}`).toContain(step);
    }
  });

  it("若 CI 含调用模型的 E2E/压测步骤，必须强制校验 mock 以免烧真实费用", async () => {
    const fs = await import("node:fs");
    const ci = fs.readFileSync(".github/workflows/ci.yml", "utf8");
    const callsModel = /npm run e2e|npm run load-test|load-test\.mts/.test(ci);
    if (!callsModel) return;   // 精简版 CI 不跑这些步骤，无需校验
    expect(ci, "CI 会调用模型但未校验 mock_enabled").toContain("mock_enabled");
  });
});

describe("健康探针与运维能力", () => {
  it("/api/health 只答存活，不查数据库不调模型", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/health/route.ts", "utf8");
    expect(src).not.toMatch(/db\(\)|ensureSchema|modelGateway/);
    const mod: any = await import("@/app/api/health/route");
    const res = await mod.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime_seconds).toBe("number");
  });

  it("/api/ready 检查数据库/迁移/模型链路，不泄露密钥", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/ready/route.ts", "utf8");
    expect(src).toContain("schema_migrations");     // 确认迁移已应用
    expect(src).toContain("configuredProviders");   // 模型链路
    // 快照仅对 admin 可见，且不含连接串明文
    expect(src).toContain('resolveTier(req) === "admin"');
    expect(src).not.toMatch(/process\.env\.DATABASE_URL\s*\}/);   // 不直接回传连接串
  });

  it("压测支持 queue-only 模式（CI 门禁用，不消耗模型）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/load-test.mts", "utf8");
    expect(src).toContain("queue-only");
    expect(src).toContain("LOAD_MODE");
    expect(src).toContain("DEDUP_FAILED");          // 幂等校验
    expect(src).toContain("LOAD_OUT");              // JSON 输出供 CI 断言
  });

  it("压测结果断言脚本存在且检查关键指标", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/assert-load-result.mjs", "utf8");
    for (const k of ["success_rate", "p95_seconds", "db_errors", "http_429"]) {
      expect(src, `断言脚本缺少 ${k} 检查`).toContain(k);
    }
    expect(src).toContain("真实费用");               // 误用真实模型时告警
  });

  it("Worker 启动冒烟测试存在", async () => {
    const fs = await import("node:fs");
    expect(fs.existsSync("tests/worker-startup.test.ts")).toBe(true);
  });

  it(".mts 脚本纳入类型检查范围（此前是盲区）", async () => {
    const fs = await import("node:fs");
    const tsconfig = JSON.parse(fs.readFileSync("tsconfig.json", "utf8").replace(/\/\/.*/g, ""));
    expect(tsconfig.include, "scripts/*.mts 不在检查范围内，缺失 import 无法被发现")
      .toContain("**/*.mts");
  });

  it("国内模型接入文档存在且列出预置厂商", async () => {
    const fs = await import("node:fs");
    const doc = fs.readFileSync("docs/PROVIDER-SETUP.md", "utf8");
    for (const p of ["QWEN_", "DEEPSEEK_", "GLM_", "MOONSHOT_", "CUSTOM_"]) {
      expect(doc, `文档缺少 ${p} 说明`).toContain(p);
    }
    expect(doc).toContain("不需要改任何代码");
  });
});

describe("压测费用保护的适用范围", () => {
  it("queue-only 不调用模型，不应被费用确认门槛拦截", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/load-test.mts", "utf8");
    // 门槛必须排除 queue-only，否则 CI 会以 exit 1 失败
    expect(src).toContain('MODE !== "queue-only"');
  });

  it("full 模式仍保留费用确认门槛", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/load-test.mts", "utf8");
    expect(src).toContain("ALLOW_MOCK_ASSUMED");
    expect(src).toContain("会产生真实模型费用");
  });

  it("CI 的 queue smoke 显式声明 mock 与确认变量（双保险）", async () => {
    const fs = await import("node:fs");
    const ci = fs.readFileSync(".github/workflows/ci.yml", "utf8");
    const step = ci.slice(ci.indexOf("Queue smoke"));
    expect(step).toContain('ENABLE_MOCK_PROVIDER: "1"');
    expect(step).toContain('ALLOW_MOCK_ASSUMED: "1"');
  });
});

describe("后台图片字段的可发现性", () => {
  it("图片字段位于「基本信息」区，而非埋在页面底部的资产区", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/AdminClient.tsx", "utf8");
    const basicStart = src.indexOf("<h4>基本信息</h4>");
    const basicEnd = src.indexOf("<h4>接口定义", basicStart);
    const imageField = src.indexOf('<F label="图片">');
    expect(basicStart).toBeGreaterThan(-1);
    expect(imageField).toBeGreaterThan(basicStart);
    expect(imageField, "图片字段应在基本信息区内，否则用户看不到").toBeLessThan(basicEnd);
  });

  it("填入图片后立即有预览与删除按钮", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/AdminClient.tsx", "utf8");
    expect(src).toContain("module-gallery");
    expect(src).toContain("图片无法加载");   // 防盗链时给出可读提示
  });
});

describe("模块图片批量管理", () => {
  it("提供 list/set/import/check 四个子命令", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/module-images.mts", "utf8");
    for (const c of ['cmd === "list"', 'cmd === "set"', 'cmd === "import"', 'cmd === "check"']) {
      expect(src, `缺少子命令 ${c}`).toContain(c);
    }
  });

  it("check 会校验 content-type，能识别防盗链返回的非图片响应", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/module-images.mts", "utf8");
    expect(src).toContain("content-type");
    expect(src).toContain('type.startsWith("image/")');
    expect(src).toContain("防盗链");
  });

  it("播种不覆盖人工录入的图片与证据记录", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/seed.mts", "utf8");
    expect(src).toContain("old.images?.length && !m.images?.length");
    expect(src).toContain("保留了");
  });

  it("package.json 注册了 module-images 命令", async () => {
    const fs = await import("node:fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    expect(pkg.scripts["module-images"]).toBeTruthy();
  });
});

describe("首页板块与上传功能（防回归）", () => {
  it("首页不再包含「今日备赛任务」与「热门知识点」", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/pages-core.tsx", "utf8");
    expect(src).not.toContain("今日备赛任务");
    expect(src).not.toContain("热门知识点");
    expect(src).not.toContain("PREP_TASKS");
    expect(src).not.toContain("KNOWLEDGE_POINTS");
  });

  it("后台提供图片上传（而不只是填 URL）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/AdminClient.tsx", "utf8");
    expect(src).toContain('type="file"');
    expect(src).toContain("accept=\"image/*\"");
    expect(src).toContain("uploadImages");
    expect(src).toContain("上传图片");
  });

  it("上传的图片在浏览器端压缩，避免撑爆数据库", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/AdminClient.tsx", "utf8");
    expect(src).toContain("MAX_EDGE");
    expect(src).toContain("MAX_BYTES");
    expect(src).toContain("canvas.toBlob");            // 异步编码，不阻塞界面
    expect(src).toMatch(/quality = Math\.max/);        // 超限时按比例再压一次
  });

  it("缩略图不使用会塌陷的 aspect-ratio + height:auto 组合", async () => {
    const fs = await import("node:fs");
    const css = fs.readFileSync("app/globals.css", "utf8");
    expect(css).toMatch(/\.mod-card \.thumb \{[\s\S]{0,120}height:\s*74px/);
    expect(css).not.toMatch(/\.mod-card \.thumb \{ aspect-ratio: 1 \/ 1; height: auto/);
  });
});

describe("图片上传的性能与可读性", () => {
  it("输入框只显示外链，不塞入 base64 数据", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/AdminClient.tsx", "utf8");
    expect(src).toContain("function linkOnly");
    expect(src).toContain('!x.startsWith("data:")');
    // 输入框绑定的是过滤后的外链，而非完整列表
    expect(src).toContain("value={linkOnly(draft.images).join");
    expect(src).not.toContain("value={lines(draft.images)}");
  });

  it("编辑外链时保留已上传的图片", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/AdminClient.tsx", "utf8");
    // 只改外链部分，data: 开头的上传图必须原样保留
    expect(src).toContain('const uploaded = (draft.images || []).filter((x: string) => x.startsWith("data:"))');
    expect(src).toContain("set(\"images\", [...uploaded, ...links])");
  });

  it("上传用 createImageBitmap 解码，避免 FileReader→Image 多次转换", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/AdminClient.tsx", "utf8");
    expect(src).toContain("createImageBitmap(file)");
    expect(src).toContain("bitmap.close()");
    // 用 toBlob（异步）而非 toDataURL（同步阻塞）
    expect(src).toContain("canvas.toBlob");
  });

  it("按像素数预估质量，最多再压一次，不做循环重编码", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/AdminClient.tsx", "utf8");
    const fn = src.slice(src.indexOf("async function uploadImages"), src.indexOf("setUploading(null)"));
    expect(fn).toContain("px > 400_000");
    // 不得有 while 循环降质
    expect(fn).not.toMatch(/while\s*\([^)]*quality/);
  });

  it("多张上传时显示进度", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/AdminClient.tsx", "utf8");
    expect(src).toContain("setUploading({ done:");
    expect(src).toContain("正在处理");
  });
});
