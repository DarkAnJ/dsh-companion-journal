/**
 * 系统桥：唯一允许碰进程、文件、截屏的地方。
 *
 * 两条硬约束（都是踩出来的）：
 *   1. 起进程走 `ctx.subprocess`，不用裸 `node:child_process`。宿主进程在
 *      macOS 沙箱下会拒绝以管道 stdio spawn（EPERM）。裸 spawn 只是脱离 DSH
 *      时的退路，跑测试用得上。
 *   2. `screencapture` 与 `osascript` 的失败信息必须原样保留。TCC 拒绝时
 *      screencapture 只说 "could not create image from window"，osascript 只说
 *      "A privilege violation occurred. (-10004)" —— 这两句话是用户唯一能据此
 *      去系统设置里点授权的线索，糊成 "capture failed" 就等于让人无从下手。
 *
 * @module dsh-companion-journal/lib/native
 */

import { spawn as spawnProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_PATH = fileURLToPath(new URL('../bridge/bin/dsh-bridge', import.meta.url));

/** 桥二进制路径（热键监听等常驻模式也要用）。 */
export const bridgePath = BRIDGE_PATH;

/** 业务错误：带可判别的 code，供工具层翻译成模型看得懂的话。 */
export class BridgeError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

/** 把各种可能的输出容器统一成字符串。 */
function decodeOutput(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (typeof value === 'object') {
    for (const key of ['text', 'content', 'string', 'data', 'bytes']) {
      if (key in value) {
        try {
          return decodeOutput(value[key]);
        } catch {
          /* 继续试下一个键 */
        }
      }
    }
  }
  try {
    return String(value);
  } catch {
    return '';
  }
}

/**
 * 软取可选服务。
 *
 * 不能直接读 `ctx.subprocess`：DSH 的 ctx 是严格 getter，没写进 inject 的服务
 * 一读就抛。`ctx.get(name, false)` 在缺失时返回
 * undefined 且不抛；测试里的假 ctx 没有 get，就回落到属性读取。
 */
function optionalService(ctx, name) {
  const get = ctx?.get;
  if (typeof get === 'function') {
    try {
      return get.call(ctx, name, false);
    } catch {
      return undefined;
    }
  }
  try {
    return ctx?.[name];
  } catch {
    return undefined;
  }
}

/**
 * 跑一个进程并收集标准输出。
 *
 * 优先 ctx.subprocess（宿主提供，能穿过沙箱）；它不可用或解码失败时退回
 * node:child_process —— 后者在 DSH 里通常会被沙箱拦掉，但本地 `node --test`
 * 与脱离 DSH 的场景需要它，所以不能删。
 */
export async function runProcess(ctx, argv, { timeoutMs = 15000, cwd, allowNonZero = false } = {}) {
  const subprocess = optionalService(ctx, 'subprocess');
  if (subprocess && typeof subprocess.spawn === 'function') {
    try {
      const handle = subprocess.spawn({
        argv,
        cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4 * 1024 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
        graceMs: 2000,
      });
      const timer = setTimeout(() => {
        try {
          handle.kill?.('SIGKILL');
        } catch {
          /* 已经退出 */
        }
      }, timeoutMs);
      try {
        const outcome = await handle.done;
        const stdout = decodeOutput(handle.collected?.stdout?.readFrom?.(0));
        const stderr = decodeOutput(handle.collected?.stderr?.readFrom?.(0));
        return { code: outcome?.exitCode ?? null, signal: outcome?.signal ?? null, stdout, stderr };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      // 落到下面的 child_process 分支：这里不吞掉原因，交给最终失败信息带上。
      const fallback = await spawnFallback(argv, { timeoutMs, cwd });
      if (fallback.code === 0 || allowNonZero) return fallback;
      // 非零退出不是「起不了进程」：把退出码和 stderr 带出去，别让上层误判成因。
      throw new BridgeError(
        'spawn-failed',
        `进程退出非零：${argv[0]}（exit ${fallback.code}）`,
        fallback.stderr || String(error?.message ?? error),
      );
    }
  }
  const result = await spawnFallback(argv, { timeoutMs, cwd });
  if (result.code === 0 || allowNonZero) return result;
  throw new BridgeError('spawn-failed', `进程退出非零：${argv[0]}（exit ${result.code}）`, result.stderr);
}

function spawnFallback(argv, { timeoutMs, cwd }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new BridgeError('spawn-failed', `起不了进程：${argv[0]}`, String(error?.message ?? error)));
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new BridgeError('spawn-failed', `起不了进程：${argv[0]}`, String(error?.message ?? error)));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** 解析桥返回的单行 JSON；解析失败时带上原始输出，便于定位编译/权限问题。 */
function parseBridgeJson(result, label) {
  const line = result.stdout.trim();
  if (!line) {
    throw new BridgeError('bridge-empty', `原生桥没有输出（${label}）`, result.stderr.trim().slice(0, 500));
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new BridgeError('bridge-bad-json', `原生桥输出不是 JSON（${label}）`, line.slice(0, 500));
  }
  if (!parsed.ok) {
    throw new BridgeError(parsed.error ?? 'bridge-failed', parsed.message ?? '原生桥报告失败', parsed);
  }
  return parsed;
}

/**
 * 把「桥本身跑不起来」和「桥跑了但业务失败」分开。
 *
 * 这两类问题的处理完全不同：前者是安装/架构/权限，用户去跑 build.sh 或换机器；
 * 后者是业务（比如 Word 没开）。混在一起会让模型对着「起不了进程」去猜窗口。
 */
function diagnoseBridgeFailure(error, stderr) {
  const text = `${String(error?.message ?? '')} ${String(error?.detail ?? '')} ${stderr ?? ''}`;
  if (/Bad CPU type|Bad CPU/i.test(text)) {
    return new BridgeError(
      'bridge-bad-arch',
      '原生桥的架构和这台机器不匹配',
      '在插件目录执行 bash bridge/build.sh 重新编译（会产出 arm64 + x86_64 通用二进制）',
    );
  }
  if (/ENOENT|no such file/i.test(text)) {
    return new BridgeError(
      'bridge-missing',
      '原生桥不存在',
      '在插件目录执行 bash bridge/build.sh（需要 Xcode Command Line Tools）',
    );
  }
  if (/EPERM|EACCES|not permitted|Operation not permitted/i.test(text)) {
    return new BridgeError(
      'bridge-not-executable',
      '原生桥没有执行权限，或被沙箱拦下',
      'chmod +x bridge/bin/dsh-bridge；若仍失败，重启 DeepSeek Harness 后再试',
    );
  }
  return error instanceof BridgeError
    ? error
    : new BridgeError('bridge-failed', '原生桥调用失败', text.trim().slice(0, 300));
}

async function callBridge(ctx, args, { timeoutMs = 10000 } = {}) {
  let result;
  try {
    result = await runProcess(ctx, [BRIDGE_PATH, ...args], { timeoutMs });
  } catch (error) {
    throw diagnoseBridgeFailure(error, '');
  }
  try {
    return parseBridgeJson(result, args[0] ?? '');
  } catch (error) {
    throw diagnoseBridgeFailure(error, result?.stderr ?? '');
  }
}

/** 权限自检：一次调用同时回答「截图能不能用」「辅助功能能不能用」。 */
export function bridgeTrust(ctx) {
  return callBridge(ctx, ['trust'], { timeoutMs: 5000 });
}

/** 可见窗口列表（含前台应用）。 */
export function listWindows(ctx, { includeUntitled = false } = {}) {
  const args = ['windows'];
  if (includeUntitled) args.push('--include-untitled');
  return callBridge(ctx, args, { timeoutMs: 8000 });
}

/** 前台应用 + 窗口标题 + 空闲时长。 */
export function frontApp(ctx) {
  return callBridge(ctx, ['frontapp'], { timeoutMs: 8000 });
}

/** 距离上一次输入事件过了多少秒。 */
export function idleSeconds(ctx) {
  return callBridge(ctx, ['idle'], { timeoutMs: 5000 });
}

/** 取 PDF 文本层。没有文本层时返回空串，由上层判断「扫描版」。 */
export function pdfText(ctx, path, { maxChars = 40000 } = {}) {
  return callBridge(ctx, ['pdftext', '--path', path, '--max-chars', String(maxChars)], { timeoutMs: 20000 });
}

/**
 * 弹一个输入框问用户「想了解什么」。
 *
 * 为什么用 osascript 而不是桥里的 NSAlert：桥是命令行子进程，AppKit 面板拿不到焦点
 * （实测：窗口可见但全灰、打不了字）。osascript 由系统脚本宿主激活，可以正常输入。
 *
 * @returns {Promise<{ok:true, text:string, cancelled:boolean}|{ok:false, reason:string}>}
 */
export async function askQuestion(ctx) {
  // 两个细节，都是踩出来的：
  //   1. 必须显式 `cancel button "取消"`，否则 Esc 不会关掉对话框（AppleScript 默认只认 Cancel）
  //   2. 必须回传 `button returned`：用户点「取消」时 osascript 在某些语言下退出码仍是 0、文本为空，
  //      只看退出码会把「取消」误判成「空输入」，接着按 F8 跑一次（实测）。
  const script = [
    'set d to display dialog "问点什么？（回车发送，取消则什么都不做）" default answer "" with title "看一眼" buttons {"取消", "发送"} default button "发送" cancel button "取消"',
    'return (button returned of d) & "\u001f" & (text returned of d)',
  ].join('\n');
  const result = await runProcess(ctx, ['osascript', '-e', script], { timeoutMs: 120000, allowNonZero: true });
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  if (result.code === 0) {
    const [button, ...rest] = stdout.split('\u001f');
    const text = rest.join('\u001f').trim();
    if (String(button).trim() === '取消') return { ok: true, text: '', cancelled: true };
    return { ok: true, text, cancelled: false };
  }
  if (stderr.includes('-128') || /cancel|取消/i.test(stderr)) return { ok: true, text: '', cancelled: true };
  return { ok: false, reason: stderr.trim().slice(0, 200) || `输入框退出码 ${result.code}` };
}

/**
 * 弹出原生文件选择器，返回用户选中的图片路径。
 *
 * 超时给 120 秒：这是等人操作，不是等系统返回，超时太短会把「还在挑图」判成失败。
 *
 * @returns {Promise<{ok:true,path:string,cancelled?:boolean}|{ok:false,reason:string}>}
 */
export async function pickImageFile(ctx) {
  // 为什么用 osascript 而不是桥里的 NSOpenPanel：
  // 桥是从 DSH 里 spawn 的命令行进程，它弹的 AppKit 面板**显示出来但拿不到焦点**
  // （整个面板是灰的、点不动，实测）。osascript 的 choose file 由系统脚本宿主负责
  // 激活，弹出来就是可用状态。
  const script =
    'POSIX path of (choose file with prompt "选择立绘" of type {"png","jpg","jpeg","webp"})';
  const result = await runProcess(ctx, ['osascript', '-e', script], { timeoutMs: 120000, allowNonZero: true });
  const out = String(result.stdout ?? '').trim();
  if (result.code === 0 && out !== '') return { ok: true, path: out };
  const err = String(result.stderr ?? '');
  if (err.includes('-128') || /cancel/i.test(err)) return { ok: true, path: '', cancelled: true };
  return { ok: false, reason: err.trim() === '' ? `选择器退出码 ${result.code}` : err.trim().slice(0, 200) };
}

/**
 * 读当前选中文本。没选中时 text 为空串，不是错误。
 *
 * `--copy` 打开剪贴板兜底：AX 读不到就用 ⌘C + 剪贴板（微信、Electron 应用只有这条路）。
 * 代价是那一刻会短暂改写剪贴板，桥会在读完后还原。
 */
export function selectionText(ctx) {
  return callBridge(ctx, ['selection', '--copy'], { timeoutMs: 8000 });
}

/** 辅助功能读取焦点元素文本（实验性）。 */
export function axText(ctx, pid) {
  return callBridge(ctx, ['axtext', '--pid', String(pid)], { timeoutMs: 8000 });
}

/**
 * 跑一段 AppleScript，返回原始字符串。
 *
 * 错误分类很关键：-1743 是用户没授权自动化，-10004 是本次调用被拒，
 * -1728 是对象不存在（比如 Word 没打开文档）。三者对用户的含义完全不同。
 */
export async function runAppleScript(ctx, lines, { timeoutMs = 15000 } = {}) {
  const argv = ['/usr/bin/osascript'];
  for (const line of lines) argv.push('-e', line);
  const result = await runProcess(ctx, argv, { timeoutMs });
  const stderr = result.stderr.replace(/^(TISFileInterrogator|Keyboard Layouts).*$/gm, '').trim();
  if (result.code !== 0) {
    if (/-1743/.test(stderr)) {
      throw new BridgeError('automation-denied', '系统拒绝了自动化授权', stderr);
    }
    if (/-10004/.test(stderr)) {
      throw new BridgeError('automation-denied', '自动化授权被拒绝（-10004）', stderr);
    }
    if (/-1728/.test(stderr)) {
      throw new BridgeError('no-such-object', '目标对象不存在（可能没有打开的文档）', stderr);
    }
    if (/timed out|-1712/i.test(stderr)) {
      throw new BridgeError('script-timeout', 'AppleScript 超时（目标应用没有响应）', stderr);
    }
    throw new BridgeError('script-failed', 'AppleScript 失败', stderr || `exit ${result.code}`);
  }
  return result.stdout.trim();
}

/**
 * 对一张图做本地 OCR（Vision），返回 { text, lines }。
 *
 * 走桥而不是在 Node 侧做：Vision 只能在 Swift 侧调用，而且能复用桥已有的授权身份。
 * OCR 只是增强项，失败不抛错（返回空文本），不影响主流程。
 */
export async function ocrImage(ctx, bytes) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-companion-journal-ocr-'));
  const file = join(dir, 'shot.png');
  try {
    await writeFile(file, bytes);
    const { stdout } = await runProcess(ctx, [bridgePath, 'ocr', '--file', file], { timeoutMs: 30000 });
    const payload = JSON.parse(String(stdout || '{}'));
    return { text: String(payload.text ?? ''), lines: Array.isArray(payload.lines) ? payload.lines : [] };
  } catch (error) {
    if (process.env.DSH_COMPANION_DEBUG_OCR) console.error('[ocr] 失败:', error);
    return { text: '', lines: [] };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 截一张图到临时文件，返回路径与像素尺寸。
 *
 * `target` 支持三种：整屏、指定 windowId、指定区域。窗口截图用 `-l`，
 * 好处是被遮挡也能截到目标自己的内容；代价是必须有屏幕录制授权。
 */
/**
 * 光标所在显示器的矩形（CG 坐标，左上原点）。多显示器下「截桌面」要用它。
 *
 * 不能直接用主屏：外接屏上的桌面和主屏是两个不同的画面。
 */
export async function cursorScreen(ctx) {
  try {
    const { stdout } = await runProcess(ctx, [bridgePath, 'cursorscreen'], { timeoutMs: 5000 });
    const payload = JSON.parse(String(stdout || '{}'));
    if (!payload?.ok) return null;
    const { x, y, w, h } = payload;
    if ([x, y, w, h].some((value) => !Number.isFinite(Number(value)))) return null;
    return {
      x: Number(x),
      y: Number(y),
      w: Number(w),
      h: Number(h),
      // 诊断用：光标在哪个点，截错屏时能直接看出是谁的问题。
      mouseX: Number(payload.mouseX ?? NaN),
      mouseY: Number(payload.mouseY ?? NaN),
    };
  } catch {
    return null;
  }
}

/**
 * 所有显示器的矩形（CG 坐标）。
 *
 * 桌面截图走「每块屏各截一张」，而不是猜「用户在看的哪块」——
 * 猜就需要跟踪光标（持续监控），而监控不是我们想要的东西。
 */
export async function screens(ctx) {
  try {
    const { stdout } = await runProcess(ctx, [bridgePath, 'screens'], { timeoutMs: 5000 });
    const payload = JSON.parse(String(stdout || '{}'));
    if (!payload?.ok || !Array.isArray(payload.screens)) return [];
    return payload.screens
      .map((one) => ({
        x: Number(one.x),
        y: Number(one.y),
        w: Number(one.w),
        h: Number(one.h),
        name: String(one.name ?? ''),
        builtin: Boolean(one.builtin),
      }))
      .filter((one) => [one.x, one.y, one.w, one.h].every((value) => Number.isFinite(value)));
  } catch {
    return [];
  }
}

export async function captureScreen(ctx, { windowId, screen = false, region, maxWidth = 0 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-companion-journal-'));
  const file = join(dir, 'shot.png');
  const argv = ['/usr/sbin/screencapture', '-x', '-o', '-t', 'png'];
  if (typeof windowId === 'number' && windowId > 0) {
    argv.push('-l', String(windowId));
  } else if (region) {
    argv.push('-R', `${region.x},${region.y},${region.w},${region.h}`);
  } else if (!screen) {
    // 没给目标又没有明确说整屏：默认就是整屏，别让调用方以为截到了窗口。
    screen = true;
  }
  argv.push(file);

  const result = await runProcess(ctx, argv, { timeoutMs: 15000 });
  if (result.code !== 0) {
    await rm(dir, { recursive: true, force: true });
    const stderr = result.stderr.trim();
    if (/could not create image/i.test(stderr)) {
      throw new BridgeError(
        'no-permission',
        '截不了屏：没有「屏幕录制」授权',
        '到 系统设置 → 隐私与安全性 → 屏幕录制，勾选 DeepSeek Harness，然后重启应用',
      );
    }
    if (/Invalid window id|-25201/i.test(stderr)) {
      throw new BridgeError('window-gone', '目标窗口已经不在了', stderr);
    }
    throw new BridgeError('capture-failed', '截图失败', stderr || `exit ${result.code}`);
  }

  // 缩放在落盘后原地做：Retina 截图动辄 3000+ 像素宽，原样塞给模型既慢又贵，
  // 而 sips 是系统自带的，不需要引入图像库。
  if (maxWidth > 0) {
    const resized = await runProcess(ctx, ['/usr/bin/sips', '-Z', String(Math.round(maxWidth)), file], {
      timeoutMs: 15000,
    });
    if (resized.code !== 0) {
      // 缩放失败不该让整次截图失败：大图也能用，只是更贵。
      console.warn(`[dsh-companion-journal] sips 缩放失败，保留原图：${resized.stderr.trim().slice(0, 200)}`);
    }
  }

  const bytes = await readFile(file);
  await rm(dir, { recursive: true, force: true });
  if (bytes.length === 0) throw new BridgeError('capture-empty', '截图结果是空文件');
  return { bytes, mediaType: 'image/png', size: pngSize(bytes) };
}

/**
 * 从 PNG 的 IHDR 直接读宽高：不引入图像库，也不为两个数字多起一个进程。
 * 不是 PNG 就返回 null（调用方按未知处理）。
 */
export function pngSize(bytes) {
  if (!bytes || bytes.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== signature[i]) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** 桥二进制是否存在；不存在时给出可操作的修复指令。 */
export async function bridgeStatus() {
  try {
    const { access } = await import('node:fs/promises');
    await access(BRIDGE_PATH);
    return { ok: true, path: BRIDGE_PATH };
  } catch {
    return {
      ok: false,
      path: BRIDGE_PATH,
      hint: '原生桥没编译：在插件目录执行 bash bridge/build.sh（需要 Xcode Command Line Tools）',
    };
  }
}
