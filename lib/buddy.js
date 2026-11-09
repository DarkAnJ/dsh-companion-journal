/**
 * 自绘桌宠（浮窗进程）的宿主侧封装。
 *
 * 职责只有三件：
 *   1. 拉起 / 看护 `dsh-buddy` 进程（崩了退避重启，插件卸载时杀掉）
 *   2. 写气泡：把一段话交给浮窗显示
 *   3. 收点击：浮窗把「看一眼 / 打开记录」追加到 press 文件，我们监听目录消费
 *
 * 为什么用文件而不用 socket：浮窗是独立进程，文件 IPC 崩了也不会连带插件；
 * 一个几百字节的本地文件，轮询成本可以忽略。
 *
 * @module dsh-companion-journal/lib/buddy
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, watch as watchDir, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 浮窗状态：是否在跑、最后说了什么、最近一次点击。 */
export const buddyState = {
  running: false,
  pid: null,
  restarts: 0,
  lastSaidAt: 0,
  lastError: null,
  /** 监听到的事件行数（诊断用：判断是浮窗没发、还是宿主没收到）。 */
  eventsSeen: 0,
};

/**
 * 通过浮窗问一句（多行输入框，贴着人物上方弹出）。
 *
 * 协议：写请求文件 {id,prompt} → 浮窗弹面板 → 用户提交后写响应 {id,text,cancelled}。
 * 为什么走文件而不是 HTTP：和气泡/点击同一套机制，浮窗是独立进程，崩了也不牵连。
 *
 * @returns {Promise<{ok:true,text:string,cancelled:boolean}|{ok:false,reason:string}>}
 */
export async function askViaBuddy(paths, prompt, { timeoutMs = 120000 } = {}) {
  const id = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  try {
    writeJsonAtomic(paths.askRequestPath, { id, prompt: String(prompt ?? ''), at: Date.now() });
  } catch (error) {
    return { ok: false, reason: `写请求失败：${String(error?.message ?? error)}` };
  }

  const startedAt = Date.now();
  // 轮询响应文件：100ms 一次，只读一个几百字节的小文件。
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const text = await readFile(paths.askResponsePath, 'utf8');
      const parsed = JSON.parse(text);
      if (String(parsed?.id ?? '') !== id) continue;
      return {
        ok: true,
        text: String(parsed?.text ?? ''),
        cancelled: Boolean(parsed?.cancelled),
      };
    } catch {
      /* 还没写出来 */
    }
  }
  return { ok: false, reason: '提问超时（120s）' };
}

/** 把 say 文件写成「原子替换」，避免浮窗读到半个 JSON。 */
/** 先写临时文件再 rename：目录监听只看得到 rename 事件，原地写收不到。 */
export function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

/**
 * 让浮窗说一句话。
 *
 * @param paths - `{ sayPath }`
 * @param text - 要显示的内容（气泡里换行会按宽度自动折行）
 * @param recordId - 这条话对应的记录 id，点气泡时回传给插件
 */
export function sayBubble(paths, text, { recordId = '', compact = false, bold = false, sticky = false, actions = [], top = '' } = {}) {
  const body = String(text ?? '').trim();
  if (body === '') return { ok: false, reason: 'empty' };
  try {
    writeJsonAtomic(paths.sayPath, {
      text: body,
      id: String(recordId ?? ''),
      at: Date.now(),
      ...(compact ? { compact: true } : {}),
      ...(bold ? { bold: true } : {}),
      ...(sticky ? { sticky: true } : {}),
      ...(Array.isArray(actions) && actions.length > 0 ? { actions } : {}),
      // 段输出气泡：控制条上方那块，只在「展开」时由宿主给内容。
      ...(String(top ?? '').trim() !== '' ? { top: String(top).trim() } : {}),
    });
    buddyState.lastSaidAt = Date.now();
    return { ok: true };
  } catch (error) {
    buddyState.lastError = String(error?.message ?? error);
    return { ok: false, reason: buddyState.lastError };
  }
}

/**
 * 让气泡消失（不显示新内容）。
 *
 * 用途：常驻气泡里有「知道了」这类按钮，点击后要能主动收起，否则它会一直挂着。
 * 写一个 `{hide:true}` 的命令，浮窗读到就隐藏。
 */
/** 把桌宠窗口收起来（进程、热键与气泡能力都还在）。 */
export function hidePet(paths) {
  try {
    writeJsonAtomic(paths.sayPath, { hidePet: true, at: Date.now() });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/** 把隐藏的桌宠重新显示出来（不抢焦点）。 */
export function showPet(paths) {
  try {
    writeJsonAtomic(paths.sayPath, { show: true, at: Date.now() });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

export function hideBubble(paths) {
  try {
    writeJsonAtomic(paths.sayPath, { hide: true, at: Date.now() });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/**
 * 启动问候：短、单行、贴在桌宠头顶。
 * 作用不是卖萌，是让你重启后一眼看到它落在屏幕哪儿（多屏时尤其明显）。
 */
const WELCOME_TEXT = '我在这儿';

/**
 * 拉起浮窗并看护它。
 *
 * @param opts.binPath - `dsh-buddy` 可执行文件
 * @param opts.assetPath - 立绘 PNG
 * @param opts.paths - `{ statePath, sayPath, pressPath }`
 * @param opts.onPress - `({ action, id })`，action 为 `look` / `open` / `panel`
 */
export function startBuddy({ binPath, assetPath, paths, onPress, logger, size = 160, fontSize = 13, maxBubbleChars = 400, debugHitbox = false, hotkeys = {} }) {
  let stopped = false;
  let child = null;
  let watcher = null;
  let offset = 0;
  let restartTimer = null;
  let healthyTimer = null;
  let greeted = false;

  const ensureFile = (path) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      if (!existsSync(path)) writeFileSync(path, '');
    } catch (error) {
      logger?.warn?.(`[dsh-companion-journal] 浮窗文件准备失败：${String(error?.message ?? error)}`);
    }
  };

  const launch = () => {
    if (stopped) return;
    if (!existsSync(binPath)) {
      buddyState.lastError = `浮窗进程不存在：${binPath}`;
      logger?.warn?.(`[dsh-companion-journal] ${buddyState.lastError}`);
      return;
    }
    try {
      child = spawn(
        binPath,
        [
          '--asset', assetPath,
          '--state', paths.statePath,
          '--say', paths.sayPath,
          '--press', paths.pressPath,
          '--size', String(size),
          '--font-size', String(fontSize),
          '--max-bubble-chars', String(maxBubbleChars),
          ...(debugHitbox ? ['--debug-hitbox', '1'] : []),
          '--hotkey-look', String(hotkeys.look || 'F8'),
          '--hotkey-ask', String(hotkeys.ask || 'F7'),
          '--hotkey-collect', String(hotkeys.collect || 'F9'),
          '--recenter', paths.recenterPath,
        ],
        { detached: false, stdio: 'ignore' },
      );
      buddyState.running = true;
      buddyState.pid = child.pid ?? null;
      buddyState.lastError = null;
      // 稳定跑满 60 秒就把重启计数清零：否则偶尔崩几次之后，
      // 退避会永久停在 30 秒，看起来像「重启很慢」。
      healthyTimer = setTimeout(() => {
        buddyState.restarts = 0;
      }, 60_000);
      healthyTimer?.unref?.();

      // 启动问候：只在「第一次拉起」时出现。崩溃退避重启会再进这里，
      // 但 greeted 已经是 true，所以不会每 30 秒刷一句。
      // 延时一点，等窗口真正出现在屏幕上再说，否则说了也看不见。
      if (!greeted) {
        greeted = true;
        const greetTimer = setTimeout(() => {
          if (stopped || !child) return;
          sayBubble(paths, WELCOME_TEXT, { compact: true });
        }, 1200);
        greetTimer?.unref?.();
      }

      child.on('exit', (code, signal) => {
        if (healthyTimer) clearTimeout(healthyTimer);
        buddyState.running = false;
        buddyState.pid = null;
        if (stopped) return;
        // 崩了就退避重启：1s、2s、4s…最多 30s，避免疯狂拉起打满 CPU。
        buddyState.restarts += 1;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(5, buddyState.restarts - 1));
        logger?.warn?.(`[dsh-companion-journal] 浮窗退出（code=${code} signal=${signal}），${delay}ms 后重启`);
        restartTimer = setTimeout(launch, delay);
        restartTimer?.unref?.();
      });
    } catch (error) {
      buddyState.lastError = String(error?.message ?? error);
      logger?.warn?.(`[dsh-companion-journal] 浮窗启动失败：${buddyState.lastError}`);
    }
  };

  ensureFile(paths.pressPath);
  ensureFile(paths.sayPath);
  launch();

  // 监听目录而不是文件：和热键事件同一个理由（单文件 kqueue 会失效）。
  try {
    const dir = dirname(paths.pressPath);
    const name = paths.pressPath.slice(dir.length + 1);
    offset = existsSync(paths.pressPath) ? readFileSyncSafe(paths.pressPath).length : 0;
    watcher = watchDir(dir, { persistent: false }, (_event, filename) => {
      if (filename && String(filename) !== name) return;
      void readFile(paths.pressPath, 'utf8')
        .then((text) => {
          if (text.length <= offset) return;
          const appended = text.slice(offset);
          offset = text.length;
          buddyState.eventsSeen += appended.split('\n').filter((line) => line.trim() !== '').length;
          for (const line of appended.split('\n')) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              if (event?.action) {
                onPress?.({
                  action: String(event.action),
                  id: String(event.id ?? ''),
                  // 点桌宠时鼠标落在桌宠上，「光标所在屏」不可用；带上「点之前停在哪块屏」。
                  cursorOverPet: event.cursorOverPet === true,
                  awayScreen:
                    event.awayScreen && typeof event.awayScreen === 'object'
                      ? {
                          x: Number(event.awayScreen.x),
                          y: Number(event.awayScreen.y),
                          w: Number(event.awayScreen.w),
                          h: Number(event.awayScreen.h),
                        }
                      : null,
                });
              }
            } catch {
              /* 半行 JSON：下一轮再读 */
            }
          }
        })
        .catch((error) => logger?.warn?.(`[dsh-companion-journal] 读浮窗事件失败：${String(error?.message ?? error)}`));
    });
  } catch (error) {
    logger?.warn?.(`[dsh-companion-journal] 浮窗事件监听失败：${String(error?.message ?? error)}`);
  }

  return {
    ok: true,
    say: (text, options) => sayBubble(paths, text, options),
    dispose: () => {
      stopped = true;
      try {
        watcher?.close?.();
      } catch {
        /* 忽略 */
      }
      if (restartTimer) clearTimeout(restartTimer);
      if (healthyTimer) clearTimeout(healthyTimer);
      try {
        child?.kill?.();
      } catch {
        /* 忽略 */
      }
      buddyState.running = false;
      buddyState.pid = null;
    },
  };
}

/** 同步读一个小文件（只用于初始化 offset）。 */
function readFileSyncSafe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
