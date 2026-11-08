/**
 * 全局热键：注册在 DSH 自己的 Electron 主进程里，**不新增常驻进程**。
 *
 * 为什么不用 Swift 常驻监听：宿主本身就是 Electron 应用，`globalShortcut` 用的是
 * 同一套系统级热键机制，空闲时不醒、按下不抢焦点——再起一个进程纯属浪费。
 *
 * 失败是结构化的（不是抛异常）：热键被别的应用占用、或宿主不在 Electron 主进程，
 * 都返回原因，由上层告警并让 `/state` 显示出来。
 *
 * @module dsh-companion-journal/lib/hotkey
 */

import { spawn as spawnProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { watch as watchFile, existsSync as existsSyncFs } from 'node:fs';
import { dirname, basename } from 'node:path';

const MODIFIERS = {
  command: 'Command',
  cmd: 'Command',
  option: 'Alt',
  opt: 'Alt',
  alt: 'Alt',
  control: 'Control',
  ctrl: 'Control',
  shift: 'Shift',
};

/**
 * 把配置里的 `option+shift+L` 规范成 Electron 的 `Alt+Shift+L`。
 * @returns {{ok:true, accelerator:string}|{ok:false, reason:string}}
 */
export function parseAccelerator(spec) {
  const raw = String(spec ?? '').trim();
  if (raw === '') return { ok: false, reason: 'hotkey.spec 为空' };
  const parts = raw.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return { ok: false, reason: `无法解析热键：${raw}` };

  const key = parts.pop();
  const mods = [];
  for (const part of parts) {
    const mod = MODIFIERS[part.toLowerCase()];
    if (!mod) return { ok: false, reason: `未知修饰键：${part}（可用 command/option/control/shift）` };
    if (!mods.includes(mod)) mods.push(mod);
  }
  const isFn = /^f([1-9]|1[0-9])$/i.test(key);
  const isChar = /^[a-z0-9]$/i.test(key);
  const named = ['space', 'tab', 'return', 'enter', 'escape', 'up', 'down', 'left', 'right', 'backspace', 'delete'];
  const keyName = isFn
    ? key.toUpperCase()
    : isChar
      ? key.toUpperCase()
      : named.includes(key.toLowerCase())
        ? key[0].toUpperCase() + key.slice(1).toLowerCase()
        : null;
  if (!keyName) return { ok: false, reason: `不支持的键：${key}` };

  const accelerator = [...mods, keyName].join('+');
  return { ok: true, accelerator };
}

/** 拿到 Electron 的 globalShortcut；拿不到（非主进程/非桌面端）返回原因。 */
async function shortcutModule() {
  try {
    const electron = await import('electron');
    const shortcut = electron?.globalShortcut ?? electron?.default?.globalShortcut;
    if (!shortcut || typeof shortcut.register !== 'function') {
      return { ok: false, reason: '宿主没有暴露 Electron globalShortcut' };
    }
    return { ok: true, shortcut };
  } catch (error) {
    return { ok: false, reason: `拿不到 electron 模块：${String(error?.message ?? error)}` };
  }
}

/**
 * 注册热键。返回 disposer；失败时返回 {ok:false, reason}，绝不抛。
 * @param {string} spec 配置里的热键写法
 * @param {() => void} handler 按下时执行
 */
export async function registerHotkey(spec, handler) {
  const parsed = parseAccelerator(spec);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const mod = await shortcutModule();
  if (!mod.ok) return { ok: false, reason: mod.reason };

  let registered = false;
  try {
    registered = mod.shortcut.register(parsed.accelerator, handler);
  } catch (error) {
    return { ok: false, reason: `注册失败：${String(error?.message ?? error)}` };
  }
  if (!registered) {
    return { ok: false, reason: `热键 ${parsed.accelerator} 已被占用或系统不允许` };
  }
  return {
    ok: true,
    accelerator: parsed.accelerator,
    dispose: () => {
      try {
        mod.shortcut.unregister(parsed.accelerator);
      } catch {
        /* 卸载失败没有意义 */
      }
    },
  };
}

/**
 * 用桥的常驻监听实现全局热键（Electron 拿不到时的正路）。
 *
 * 为什么走事件文件而不是 stdout：宿主给的 subprocess 句柄是「跑完再读」的形状，
 * 长驻进程的增量输出拿不到。让桥把每次按键追加到文件，插件用 `fs.watch` 监听
 * 文件变化 —— 仍然是**事件驱动**，没有定时器轮询。
 *
 * @returns {Promise<{ok:true, dispose:()=>void}|{ok:false, reason:string}>}
 */
export async function startBridgeHotkey(ctx, { spec, binPath, eventsFile, onPress, logger, spawn = true }) {
  const subprocess = ctx?.get?.('subprocess');
  const { stat, readFile, rm } = await import('node:fs/promises');

  // 快捷指令模式下没有监听进程来建这个文件；不存在就先建一个空文件，
  // 否则 fs.watch 直接 ENOENT，整个热键链路在启动时就被判死。
  try {
    const dir = eventsFile.replace(/\/[^/]+$/, '');
    mkdirSync(dir, { recursive: true });
    if (!existsSync(eventsFile)) writeFileSync(eventsFile, '');
  } catch (error) {
    return { ok: false, reason: `热键事件文件建不出来：${String(error?.message ?? error)}` };
  }

  // 优先用 node 的 spawn + detached + stdio:'ignore'：桥只往文件写，
  // 不需要管道，正好绕开「宿主沙箱拒绝管道 stdio」与 subprocess.spawn 的校验差异。
  let child = null;
  let handle = null;
  if (!spawn) {
    // 快捷指令模式：不拉监听，只监听文件（快捷指令负责 poke）。
  } else try {
    child = spawnProcess(binPath, ['hotkeys', '--spec', spec, '--events', eventsFile], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (error) {
    if (!subprocess || typeof subprocess.spawn !== 'function') {
      return { ok: false, reason: `拉起热键监听失败：${String(error?.message ?? error)}` };
    }
    try {
      handle = subprocess.spawn({
        argv: [binPath, 'hotkeys', '--spec', spec, '--events', eventsFile],
        cwd: undefined,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
        graceMs: 2000,
      });
    } catch (inner) {
      const frame = String(inner?.stack ?? '').split('\n').find((l) => l.trim().startsWith('at '));
      return {
        ok: false,
        reason: `拉起热键监听失败：${String(inner?.message ?? inner)}${frame ? `（${frame.trim()}）` : ''}`,
      };
    }
  }

  let offset = 0;
  let stopped = false;
  let watcher = null;
  try {
    // 先等文件出现（桥启动后才创建），最多 3 秒，失败就放弃。
    for (let i = 0; i < 30; i += 1) {
      try {
        const info = await stat(eventsFile);
        offset = info.size;
        break;
      } catch {
        // 这里不能 unref：这是有界等待（最多 3s），unref 会让事件循环提前空掉，
        // 整个 promise 永远不 settle（实测就卡在这）。
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    // 盯目录而不是文件：macOS 上对单个文件的 kqueue 监听在第一次事件后就可能失效
    // （实测：第一次 poke 能触发，之后再也不触发）。目录监听稳定，且仍是事件驱动。
    const eventsDir = dirname(eventsFile);
    const eventsName = basename(eventsFile);
    watcher = watchFile(eventsDir, { persistent: false }, (_event, filename) => {
      if (filename && String(filename) !== eventsName) return;
      if (stopped) return;
      void readFile(eventsFile, 'utf8').then((text) => {
        if (text.length <= offset) return;
        const appended = text.slice(offset);
        offset = text.length;
        // 事件里带 mode（如 {"event":"hotkey","mode":"f7"}）：F7 要在抓取后先问一句。
        for (const line of appended.split('\n')) {
          if (!line.includes('"hotkey"')) continue;
          let mode = '';
          try {
            mode = String(JSON.parse(line)?.mode ?? '');
          } catch {
            mode = '';
          }
          onPress({ mode });
        }
      }).catch((error) => logger?.warn?.(`[dsh-companion-journal] 读热键事件失败：${String(error?.message ?? error)}`));
    });
    if (!existsSyncFs(eventsFile)) writeFileSync(eventsFile, '');
  } catch (error) {
    try { handle?.kill?.(); } catch { /* 忽略 */ }
    return { ok: false, reason: `热键监听没起来：${String(error?.message ?? error)}` };
  }

  return {
    ok: true,
    dispose: () => {
      stopped = true;
      try { watcher?.close?.(); } catch { /* 忽略 */ }
      try {
        handle?.kill?.();
      } catch {
        /* 忽略 */
      }
      try {
        if (child?.pid) process.kill(child.pid, 'SIGTERM');
      } catch {
        /* 已经退出 */
      }
      void rm(eventsFile, { force: true }).catch(() => {});
    },
  };
}
