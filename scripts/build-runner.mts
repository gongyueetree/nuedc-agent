/** 编译执行器（在有工具链的环境运行：GitHub Actions / 本地）。
 *  用法：BASE_URL=https://你的域名 ADMIN_API_KEY=xxx npx tsx scripts/build-runner.mts
 *  循环认领 queued 任务 → arm-none-eabi-gcc 编译链接 → size 提取 Flash/RAM →
 *  回写日志 + ELF/BIN。esp32 需 xtensa 工具链，缺失时标记 toolchain_missing。
 *
 *  诚实边界：这是"编译器级验证"（语法/类型/链接真实通过），厂商 SDK 头文件
 *  （ti_msp_dl_config.h / stm32f4xx_hal.h 等）不在环境中时会如实编译失败 ——
 *  失败日志正是学生需要看到的真实 gcc 报错。 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { validateBuildFiles } from "../lib/build-limits";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const KEY = process.env.ADMIN_API_KEY || "";
if (!KEY) {
  // 未配置视为「未启用固件编译」而非错误：定时任务不应因此反复失败
  console.log("未配置 ADMIN_API_KEY，跳过固件编译。");
  console.log("如需启用：设置 BASE_URL 与 ADMIN_API_KEY 环境变量（CI 中为 GitHub Secrets）。");
  process.exit(0);
}
const H = { "content-type": "application/json", "X-Api-Key": KEY };

const TARGET_FLAGS: Record<string, { cc: string; flags: string[] }> = {
  mspm0: { cc: "arm-none-eabi-gcc", flags: ["-mcpu=cortex-m0plus", "-mthumb"] },   // TI MSPM0 = Cortex-M0+
  stm32: { cc: "arm-none-eabi-gcc", flags: ["-mcpu=cortex-m4", "-mthumb", "-mfloat-abi=soft"] },
  esp32: { cc: "xtensa-esp32-elf-gcc", flags: [] },
};

// 最小链接脚本 + 启动桩：无厂商 SDK 时也能产出 ELF 用于 size 分析
const MINIMAL_LD = `
ENTRY(_start)
MEMORY { FLASH (rx) : ORIGIN = 0x00000000, LENGTH = 512K
         RAM  (rwx) : ORIGIN = 0x20000000, LENGTH = 128K }
SECTIONS {
  .text : { KEEP(*(.vectors)) *(.text*) *(.rodata*) } > FLASH
  .data : { *(.data*) } > RAM AT > FLASH
  .bss  : { *(.bss*) *(COMMON) } > RAM
}`;
const STARTUP_STUB = `
__attribute__((section(".vectors"))) void * const vectors[] = { (void*)0x20020000, 0 };
void _start(void) { extern int main(void); main(); while(1); }
void _exit(int c){(void)c;while(1);} int _sbrk(int i){(void)i;return -1;}
int _write(int f,char*b,int l){(void)f;(void)b;return l;} int _close(int f){(void)f;return -1;}
int _read(int f,char*b,int l){(void)f;(void)b;(void)l;return 0;}
int _lseek(int f,int o,int w){(void)f;(void)o;(void)w;return 0;}
int _fstat(int f,void*s){(void)f;(void)s;return 0;} int _isatty(int f){(void)f;return 1;}
int _kill(int p,int s){(void)p;(void)s;return -1;} int _getpid(void){return 1;}`;

function have(bin: string): boolean {
  try { execFileSync("which", [bin], { stdio: "pipe" }); return true; } catch { return false; }
}

function run(cmd: string, args: string[], cwd: string): { ok: boolean; out: string } {
  try {
    // 沙箱限额：虚拟内存 1GB / CPU 90s / 单文件产物 16MB / 进程数 64（防编译炸弹与资源耗尽）
    const wrapped = `ulimit -v 1048576 -t 90 -f 32768 -u 64; exec ${cmd} ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`;
    const out = execFileSync("bash", ["-c", wrapped], { cwd, stdio: "pipe", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }).toString();
    return { ok: true, out: out.slice(0, 100_000) };
  } catch (e: any) {
    return { ok: false, out: ((e.stdout?.toString() || "") + (e.stderr?.toString() || e.message)).slice(0, 100_000) };
  }
}

async function buildOne(job: { job_id: string; target: string; files: string }) {
  const tc = TARGET_FLAGS[job.target];
  const log: string[] = [`[runner] target=${job.target} cc=${tc.cc}`];

  if (!have(tc.cc)) {
    return { status: "toolchain_missing", log: log.concat(`[runner] 工具链 ${tc.cc} 未安装。ARM 目标：apt-get install gcc-arm-none-eabi；esp32 需 espressif xtensa 工具链。`).join("\n") };
  }

  const dir = mkdtempSync(join(tmpdir(), "build-"));
  const files: { path: string; content: string }[] = JSON.parse(job.files);
  const bad = validateBuildFiles(files);
  if (bad) return { status: "failed", log: `[runner] 输入被拒绝：${bad}` };
  for (const f of files) {
    const p = join(dir, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
  }
  writeFileSync(join(dir, "__minimal.ld"), MINIMAL_LD);
  writeFileSync(join(dir, "__startup_stub.c"), STARTUP_STUB);

  const cFiles = files.filter((f) => /\.(c|cpp)$/i.test(f.path)).map((f) => f.path);
  if (!cFiles.length) return { status: "failed", log: "没有可编译的 .c/.cpp 文件" };

  // 逐文件编译（真实 gcc 报错在这里出现）
  const objs: string[] = [];
  let allOk = true;
  for (const cf of cFiles) {
    const obj = cf.replace(/\.(c|cpp)$/i, ".o");
    const r = run(tc.cc, [...tc.flags, "-Os", "-ffunction-sections", "-fdata-sections", "-Wall", "-I.", "-c", cf, "-o", obj], dir);
    log.push(`[cc] ${cf}\n${r.out || "(无输出)"}`);
    if (!r.ok) allOk = false; else objs.push(obj);
  }
  if (!allOk) return { status: "failed", log: log.join("\n") };

  // 链接（最小脚本 + 启动桩；nano spec 减小体积）
  const stubObj = "__startup_stub.o";
  run(tc.cc, [...tc.flags, "-c", "__startup_stub.c", "-o", stubObj], dir);
  const link = run(tc.cc, [...tc.flags, "-nostartfiles", "-T", "__minimal.ld", "--specs=nano.specs",
    "-Wl,--gc-sections", ...objs, stubObj, "-o", "firmware.elf"], dir);
  log.push(`[ld]\n${link.out || "(无输出)"}`);
  if (!link.ok) return { status: "SOURCE_COMPILED", log: log.concat("[runner] 逐文件编译通过（0 错误），但最小链接失败（通常缺厂商 SDK/启动文件）。这是语法与类型级验证通过，不是可烧录工程。").join("\n") };

  // size：Flash ≈ text+data，RAM ≈ data+bss
  const size = run("arm-none-eabi-size", ["firmware.elf"], dir);
  log.push(`[size]\n${size.out}`);
  let flash: number | null = null, ram: number | null = null;
  const m = size.out.split("\n")[1]?.trim().split(/\s+/);
  if (m && m.length >= 3) {
    const [text, data, bss] = m.map(Number);
    flash = text + data; ram = data + bss;
  }
  run("arm-none-eabi-objcopy", ["-O", "binary", "firmware.elf", "firmware.bin"], dir);
  const elf = existsSync(join(dir, "firmware.elf")) ? readFileSync(join(dir, "firmware.elf")) : null;
  const bin = existsSync(join(dir, "firmware.bin")) ? readFileSync(join(dir, "firmware.bin")) : null;

  return {
    status: "MINIMAL_LINKED", log: log.join("\n"), flash_bytes: flash, ram_bytes: ram,
    elf_b64: elf && elf.length < 512_000 ? elf.toString("base64") : null,
    bin_b64: bin && bin.length < 512_000 ? bin.toString("base64") : null,
  };
}

async function main() {
  let built = 0;
  for (;;) {
    const r = await fetch(`${BASE}/api/build-jobs?claim=1&runner=${process.env.RUNNER_NAME || "local"}`, { headers: H });
    const { job } = await r.json();
    if (!job) break;
    console.log(`[runner] 认领 ${job.job_id} (${job.target})`);
    const result = await buildOne(job);
    await fetch(`${BASE}/api/build-jobs/${job.job_id}`, { method: "PATCH", headers: H, body: JSON.stringify(result) });
    console.log(`[runner] ${job.job_id} → ${result.status}${result.flash_bytes ? ` (Flash ${result.flash_bytes}B / RAM ${result.ram_bytes}B)` : ""}`);
    built++;
  }
  console.log(built ? `[runner] 完成 ${built} 个任务` : "[runner] 没有排队中的编译任务");
}
main().catch((e) => { console.error(e); process.exit(1); });
