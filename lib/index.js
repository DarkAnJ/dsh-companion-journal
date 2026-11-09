/**
 * 宿主半侧入口：把配置、原生桥、旁观器、五个工具、一个命令、一条 HTTP 路由接起来。
 *
 * 一条铁律：**apply() 绝不允许抛异常**。插件在 profile 里是 required，
 * apply 抛错会让整个 DSH 起不来并进入安全模式，进而重写 profile 把插件删掉
 * —— 也就是说，一个配置笔误的代价是「插件消失 + 用户以为坏了」。
 * 所以这里每一段都独立 try/catch，失败只降级并告警。
 *
 * @module dsh-companion-journal/lib/index
 */

import { askQuestion as askQuestionViaScript, bridgePath, bridgeStatus, bridgeTrust, cursorScreen, frontApp, pickImageFile, requestAccessibilityPermission, requestScreenPermission, runProcess, selectionText } from './native.js';
import { normalizeConfig } from './config.js';
import { createObserver } from './observer.js';
import { createHistory } from './history.js';
import { askAbout } from './chat.js';
import { buildSessionSeed, describeRecord, recordImagePaths } from './seed.js';
import { personaPath, readPersona, defaultBaseDir } from './persona.js';
import {
  buildChatSystem,
  buildLookRules,
  buildLookSystem,
  defaultLookRules,
  getUserOverrides,
  promptDefaults,
  setPromptOverrides,
} from './prompt.js';
import { createTools } from './tools.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { lookOnce, captureForCollect, describeCollection, targetLabel } from './look.js';
import { createCollection } from './collect.js';
import { createWatch, formatDuration, formatTokens, INTERVALS, TOKEN_WARNINGS } from './watch.js';
import { registerHotkey, startBridgeHotkey } from './hotkey.js';
import { setSurface, say, surfaceReady } from './surface.js';
import { askViaBuddy, hideBubble, hidePet, showPet, startBuddy, buddyState } from './buddy.js';
import { migrateLegacyDataDir } from './migrate.js';

/** 对外 HTTP 前缀：本机诊断状态（/state）与面板用，不承载跨源业务。 */
const ROUTE_SEGMENT = '/dsh-companion-journal-8201';

/** 插件根目录：用来定位随包分发的浮窗二进制与立绘。 */
// 必须用 fileURLToPath：路径里有空格/中文时 URL.pathname 会保留 %20，
// 之后 readFileSync/copyFileSync 全部找不到文件，症状是「浮窗静默不启动」。
const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** 当前代码版本：/state 里回显，用来确认运行的是哪一份（排查“改了没生效”）。 */
/** 客户端 bundle 的期望版本：只有改了 lib/client.js 才升（见 package.json `dsh.clientVersion`）。 */
const CLIENT_VERSION_EXPECTED = (() => {
  try {
    return String(JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))?.dsh?.clientVersion ?? '');
  } catch {
    return '';
  }
})();

/**
 * 当前代码版本。
 *
 * 每次读文件而不是模块加载时算一次：DSH 重挂插件时会复用模块缓存，
 * 常量会停在旧值，导致 /state 报的版本比实际代码旧（排查「改了没生效」时很误导）。
 */
function codeVersion() {
  try {
    return JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 热键事件文件：固定路径，快捷指令与插件共用。
 * 放在 DSH_HOME 下而不是临时目录，重启后路径不变，快捷指令只配一次。
 */
function hotkeyEventsPath() {
  const home = process.env.DSH_HOME || join(process.env.HOME || '/tmp', '.dsh');
  const dir = join(home, 'dsh-companion-journal');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 目录已存在或不可写，后续 watch 会报错并降级 */
  }
  return join(dir, 'hotkey.events');
}

/**
 * 把包内的桥同步到 `~/.dsh/dsh-companion-journal/bin/`。
 *
 * 为什么需要：系统服务/快捷指令调用的是这个**稳定路径**的副本（包目录在 ~/Documents 下
 * 会触发 TCC 的文稿文件夹授权，且无签名导致授权不被记住）。不同步的话，
 * 重编桥之后热键会静默继续用旧版本。
 *
 * 只在内容变化时复制（比 mtime+size），失败不抛——热键不可用不该影响插件加载。
 */
function syncBridgeCopy(logger) {
  try {
    const dir = join(hotkeyEventsPath().replace(/\/hotkey\.events$/, ''), 'bin');
    const target = join(dir, 'dsh-bridge');
    mkdirSync(dir, { recursive: true });
    let same = false;
    try {
      const a = statSync(bridgePath);
      const b = statSync(target);
      same = a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 2000;
    } catch {
      same = false;
    }
    if (!same) {
      copyFileSync(bridgePath, target);
      chmodSync(target, 0o755);
      logger?.info?.(`[dsh-companion-journal] 已同步热键用的桥副本：${target}`);
    }
    return { ok: true, path: target };
  } catch (error) {
    logger?.warn?.(`[dsh-companion-journal] 同步桥副本失败：${reasonOf(error)}`);
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/** 桌宠右键菜单里的注册方标识：一个插件一个 owner，重复注册是整体覆盖。 */
const MENU_OWNER = 'dsh-companion-journal';
/** 菜单项文案：宠物菜单宽度 150–240px，超过 32 字符会被截断。 */
const MENU_LABEL = '看一眼';

/**
 * 必须声明的服务。
 *
 * DSH 的 ctx 是**严格 getter**：读一个没写进 inject 的服务，得到的是抛异常，
 * 不是 undefined。v0.1.0 第一次装上去时 HUD 一直「连接中」、五个工具和
 * /companion 全都不存在，就是这个原因 —— 三处 `ctx.<service>` 各自抛错，
 * 又被 apply() 里的 try/catch 逐段吞掉，于是 apply「成功」但零注册。
 *
 * 只放**核心服务**。attachments / llm / subprocess 这类可选服务一律不进
 * inject：对象级 inject 会把整个 apply 推迟到所有服务就绪，缺一个就永远不加载
 * （dsh-whale-widget 的 issue #154 踩过）。可选服务用 `ctx.get(name, false)` 软取。
 */
export const inject = ['tools', 'commands', 'webServer'];

/** 把异常整理成一行可诊断的话：message + 第一帧调用栈（getter 抛错时全靠它）。 */
function reasonOf(error) {
  const message = String(error?.message ?? error);
  const frame = String(error?.stack ?? '')
    .split('\n')
    .find((line) => line.trim().startsWith('at '));
  return frame ? `${message}（${frame.trim()}）` : message;
}

export function apply(ctx, rawConfig) {
  const logger = ctx?.logger ?? console;
  // 先把旧目录整体搬到新目录，再做任何会创建新目录的事（settings / hotkey / buddy）。
  if (process.env.DSH_COMPANION_NO_MIGRATE !== '1') migrateLegacyDataDir(logger);
  const { config, warnings } = normalizeConfig(rawConfig);
  // 设置页改过的值（settings.json）覆盖 patch，改完即时生效，不用重装插件。
  // 注意 applySettings 用函数声明提升，定义在后面也能调用。
  applySettings();
  applyPromptOverrides();

  for (const warning of warnings) {
    try {
      logger.warn?.(`[dsh-companion-journal] 配置：${warning}`);
    } catch {
      /* 忽略 */
    }
  }

  // 平台边界要说在前面：少注册工具远好过注册一堆一调就报错的工具。
  const macOnly = process.platform !== 'darwin';
  if (macOnly) {
    try {
      logger.warn?.(
        '[dsh-companion-journal] 目前只支持 macOS：原生桥相关的四个工具不会注册，只保留 companion_say',
      );
    } catch {
      /* 忽略 */
    }
  }

  const observer = createObserver({ ctx, config, logger });
  const history = createHistory(config, logger);

  /**
   * 看一阵：锁定目标持续采样，文本优先分析，最后落一条时间线记录。
   * 状态通过常驻气泡反馈（暂停 / 停止 / 丢弃 / 采样率）。
   */
  const watch = createWatch({
    ctx,
    config,
    history,
    logger,
    onStatus: (s) => {
      void updateWatchBubble(s);
    },
    onFinish: ({ record, stats }) => {
      if (!record) return;
      void say(ctx, `看完了：${formatDuration(stats.durationMs)} · ${stats.windows} 段`, {
        recordId: record.id,
      }).catch(() => {});
    },
  });

  /**
   * 插件卸载 / 重挂时停掉录制。
   *
   * 不注册这条的话：旧模块实例里的采样定时器会继续跑，气泡还在计时，
   * 但按钮分发已经指向新实例 → 表现就是「按钮点了没反应」（2026-11-08 实测）。
   */
  ctx.effect(() => () => {
    stopWatchTracking();
    try {
      void watch.discard().catch(() => {});
    } catch {
      /* 忽略 */
    }
  });

  /** 截断一段文字（气泡第一行空间有限，标题只要够认出来就行）。 */
  function clipText(text, max) {
    const value = String(text ?? '').trim();
    return value.length > max ? `${value.slice(0, max)}…` : value;
  }

  /** 两个目标是不是同一个（窗口按 id，桌面按屏幕区域）。 */
  function sameWatchTarget(a, b) {
    if (!a || !b) return false;
    if (a.windowId || b.windowId) return Number(a.windowId ?? 0) === Number(b.windowId ?? 0);
    const ra = a.region;
    const rb = b.region;
    if (!ra || !rb) return false;
    return ra.x === rb.x && ra.y === rb.y && ra.w === rb.w && ra.h === rb.h;
  }

  /** 待开始的目标：点「看一阵」后气泡就出来了，但采集要等用户按「开始」。 */
  let watchPending = null;

  /**
   * 「未开始」状态的录制气泡：**和录制中同一个布局**，只是第一个按钮是「开始」。
   *
   * 用户要的是「点完看一阵看到的就是录制气泡」——不要另一个准备气泡，
   * 也不要多一个「取消」按钮；停止/丢弃在未开始时点了不生效。
   */
  async function showWatchIdleBubble() {
    const target = watchPending?.target;
    if (!target) return;
    const label = target.app
      ? `${target.app}${target.title ? `「${clipText(target.title, 18)}」` : ''}`
      : target.windowId
      ? `窗口 ${target.windowId}`
      : '桌面';
    const interval = Math.round((watchPending.intervalMs ?? 2000) / 1000);
    await say(ctx, `● 看一阵 · ${label}\n0:00 · 0 段 · 0 帧 · 0 token`, {
      sticky: true,
      compact: true,
      actions: [
        { id: 'watch-begin', label: '开始' },
        { id: 'watch-stop', label: '停止' },
        { id: 'watch-discard', label: '丢弃' },
        { id: 'watch-interval', label: `${interval}s` },
        { id: 'watch-segment-toggle', label: watchSegmentExpanded ? '段 ▾' : '段 ▸' },
      ],
    }).catch(() => {});
  }

  /** 定目标但不采集。点菜单/命令都走这里，真正的采集要等用户按「开始」。 */
  async function prepareWatch({ windowId = 0 } = {}) {
    if (watch.isActive()) return { ok: false, reason: '已经在录制' };
    const target = await resolveWatchTarget({ windowId });
    if (!target) return { ok: false, reason: '拿不到要录的窗口或屏幕' };
    stopWatchTracking();
    watchPending = {
      target,
      intervalMs: Number(config?.watch?.intervalMs) || INTERVALS[0],
      // 手动指定窗口（调试 / 以后挂菜单）不跟随前台；只有「点菜单」那种才实时跟随。
      fixed: windowId > 0,
    };
    await showWatchIdleBubble();
    return { ok: true, target };
  }

  /**
   * 准备阶段刷新目标：由**事件**触发，不是定时轮询。
   *
   * 触发来源：
   *   - 浮窗发来的 `front-changed`（NSWorkspace 应用激活通知，一次激活一条事件）；
   *   - 用户点气泡上任意按钮（顺手再看一眼前台）。
   * 为什么不用 1.2 秒轮询：一次 frontapp 查询要 150–240ms 的子进程，1.2 秒一次
   * 相当于占了一个核的 15% 左右，只为了"气泡上的应用名别过期"——不值。
   * 同一应用内切换窗口（Cmd+`）不会触发激活事件，那种情况下气泡上的名字可能滞后，
   * 但按「开始」时会重新取一次前台，锁定目标永远准确。
   */
  async function refreshPendingTarget() {
    if (!watchPending || watchPending.fixed) return;
    const next = await resolveWatchTarget({}).catch(() => null);
    if (!next || !watchPending) return;
    if (sameWatchTarget(watchPending.target, next)) return;
    watchPending.target = next;
    await showWatchIdleBubble();
  }

  function stopWatchTracking() {
    /* 现在没有定时器可清；保留函数名，调用点语义不变。 */
  }

  /** 按「开始」：用准备阶段锁定的目标启动录制。 */
  async function beginWatch() {
    if (!watchPending) return { ok: false, reason: '没有待开始的目标' };
    // 按下「开始」的这一刻再取一次前台：保证锁的是你按下时的活动窗口，不是上一拍的。
    stopWatchTracking();
    const fresh = watchPending.fixed ? null : await resolveWatchTarget({}).catch(() => null);
    const target = fresh ?? watchPending.target;
    const intervalMs = watchPending.intervalMs;
    watchPending = null;
    const started = await watch.start({ target, intervalMs });
    if (!started.ok) await say(ctx, `开不了：${started.reason}`, { compact: true }).catch(() => {});
    return started;
  }

  /** 解析录制目标：指定窗口 id，或当前前台窗口 / 光标所在屏。 */
  async function resolveWatchTarget({ windowId = 0 } = {}) {
    if (windowId > 0) {
      let meta = { app: '', title: '' };
      try {
        const { stdout } = await runProcess(ctx, [bridgePath, 'windows'], { timeoutMs: 8000 });
        const payload = JSON.parse(String(stdout || '{}'));
        const found = (payload?.windows ?? []).find((one) => Number(one.windowId) === Number(windowId));
        if (found) meta = { app: String(found.ownerName ?? ''), title: String(found.title ?? '') };
      } catch {
        /* 拿不到元信息也能录，只是气泡没应用名 */
      }
      return { windowId, ...meta };
    }
    const front = await frontApp(ctx).catch(() => null);
    if (front?.ok && Number(front.windowId) > 0 && front.desktop !== true) {
      return { windowId: Number(front.windowId), app: String(front.name ?? ''), title: String(front.windowTitle ?? '') };
    }
    const screen = await cursorScreen(ctx).catch(() => null);
    if (!screen) return null;
    return { region: { x: screen.x, y: screen.y, w: screen.w, h: screen.h }, app: '桌面', title: '' };
  }

  /** 看一阵：把状态同步到桌宠头顶那个常驻控制条。 */
  async function updateWatchBubble(s) {
    if (!s?.active) return;
    // 第一行固定是「状态 + 录的是谁」：录错窗口时能一眼看出来，不用去翻别的窗口确认。
    const target = s.target?.app
      ? ` · ${s.target.app}${s.target.title ? `「${clipText(s.target.title, 18)}」` : ''}`
      : '';
    // 收尾要等模型，几秒钟不给反馈就会被当成「按钮又失灵」——这里明确说在收尾。
    if (s.stopping) {
      await say(ctx, `⏳ 正在收尾…${target}`, { sticky: true, compact: true }).catch(() => {});
      return;
    }
    const level = [...TOKEN_WARNINGS].reverse().find((limit) => s.estTokens >= limit) ?? 0;
    const state = s.paused ? '⏸ 已暂停' : level > 0 ? '⚠ 录制中' : '● 录制中';
    const head = `${state}${target}`;
    const detail =
      `${formatDuration(s.elapsedMs)} · ${s.windows} 段 · ${s.frames} 帧${
        s.manual > 0 ? `（手动 ${s.manual}）` : ''
      } · ${formatTokens(s.estTokens)} token` +
      (level > 0 ? `（已过 ${level / 1000} 万）` : '');
    const text = `${head}\n${detail}`;
    const actions = [
      { id: s.paused ? 'watch-resume' : 'watch-pause', label: s.paused ? '继续' : '暂停' },
      { id: 'watch-stop', label: '停止' },
      { id: 'watch-discard', label: '丢弃' },
      { id: 'watch-interval', label: `${Math.round(s.intervalMs / 1000)}s` },
      { id: 'watch-segment-toggle', label: watchSegmentExpanded ? '段 ▾' : '段 ▸' },
    ];
    // 展开时才有上方那块：内容是最近一段的模型输出，新段来了就替换。
    const top = watchSegmentExpanded ? String(s.segment ?? '') : '';
    await say(ctx, text, { sticky: true, compact: true, actions, top }).catch(() => {});
  }

  /** 看一阵：以「触发那一刻」的前台窗口为目标；桌面背景则锁光标所在那块屏。 */
  /**
   * @param {object} [options]
   * @param {number} [options.windowId] 指定窗口（不给就用前台窗口）。调试与「就录这个窗户」都用它。
   */



  // 热键走的是 ~/.dsh 下的桥副本：每次加载都同步一次，避免重编后热键还在用旧二进制。
  syncBridgeCopy(logger);

  // 上次会话是隐藏状态：进程照常启动（热键、记录都在），但窗口不显示。
  if (config.buddy.enabled === true && config.buddy.visible === false) {
    setTimeout(() => hidePet(buddyPaths()), 800);
  }

  /** 菜单链路的可观测状态：点了没反应时，靠它区分「没收到点击」和「收到了但失败」。 */
  const menu = { registered: false, polls: 0, lastClickAt: 0, lastOutcome: null, lastError: null };
  /**
   * 清掉本插件创建过、但已经没人释放的 agent。
   *
   * 为什么需要：插件重挂时旧实例的 handle 会丢，没 dispose 的 agent 会一直 live 在宿主里，
   * 客户端会把它当成「当前会话」，表现为「点新会话总是带出同一条旧会话」（实测）。
   * 只在启动时跑一次，按 id 前缀识别，绝不碰用户的其它会话。
   */
  function reapStaleAgents(logger) {
    let removed = 0;
    try {
      const agents = ctx.get('agents');
      const list = agents?.list?.() ?? [];
      for (const agent of list) {
        const id = String(agent?.id ?? '');
        if (!id.startsWith('companion-')) continue;
        try {
          agent.dispose?.();
          removed += 1;
        } catch {
          /* 已经被释放 */
        }
      }
    } catch (error) {
      logger?.warn?.(`[dsh-companion-journal] 清理残留 agent 失败：${String(error?.message ?? error)}`);
    }
    if (removed > 0) logger?.info?.(`[dsh-companion-journal] 已释放 ${removed} 个残留的讨论会话 agent`);
    return removed;
  }

  reapStaleAgents(logger);

  /** 面板「开新会话」创建的 agent：跑完一轮就释放，避免残留 live 会话抢占「当前会话」。 */
  const spawnedAgents = new Set();

  /** 释放一个 agent（会话已落盘，释放不影响列表与之后打开）。 */
  function releaseSpawned(handle) {
    if (!handle) return;
    spawnedAgents.delete(handle);
    try {
      handle.dispose?.();
    } catch {
      /* 已释放 */
    }
  }

  ctx.effect(() => () => {
    for (const handle of [...spawnedAgents]) releaseSpawned(handle);
  });

    /** 用户在设置页里改过的值：存 JSON，覆盖 cordis patch 里的同名配置。 */
  function settingsPath() {
    return join(dirname(hotkeyEventsPath()), 'settings.json');
  }

  /** 用户改过的提示词：单独一个文件，跟 settings.json 分开（它更长，也更容易写坏）。 */
  function promptPath() {
    return join(dirname(hotkeyEventsPath()), 'prompt.json');
  }

  function readPromptFile() {
    try {
      const parsed = JSON.parse(readFileSync(promptPath(), 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  /** 把 prompt.json 载入 prompt 模块；文件不存在/坏了都回落到内置默认。 */
  function applyPromptOverrides() {
    try {
      setPromptOverrides(readPromptFile());
    } catch (error) {
      logger.warn?.(`[dsh-companion-journal] 提示词覆盖读取失败，已用默认：${reasonOf(error)}`);
      setPromptOverrides({});
    }
  }

  /**
   * 设置页「提示词」一栏的数据。
   *
   * text 是**规则段全文**（含密度那句，不含人设）——用户看到的、改的就是它。
   * defaults.text 是内置标准模板，供「重置」用。
   */
  function promptSettingsPayload() {
    const current = getUserOverrides();
    return {
      text: buildLookRules({ length: config.look?.length ?? 'normal' }),
      // 追问规则也回显「最终生效的文本」：框里看到的 = 实际会发的，不是空框 + 看不见的默认值。
      chat: current.chat || promptDefaults().chat,
      defaults: { text: defaultLookRules(), chat: promptDefaults().chat },
      // 三档密度的文案：设置页那个下拉用它改写文本里「4. …」那一行。
      lengths: promptDefaults().lengths,
      preview: {
        look: buildLookSystem({ length: config.look?.length ?? 'normal' }),
        chat: buildChatSystem(),
      },
    };
  }

  function readSettings() {
    try {
      const text = readFileSync(settingsPath(), 'utf8');
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  /** 把 settings.json 合并进 config（设置页优先于 patch，改完即时生效）。 */
  function applySettings() {
    const saved = readSettings();

    // look（信息密度预设）与 buddy 各自独立合并：只存了其中一个也要生效。
    const look = saved?.look && typeof saved.look === 'object' ? saved.look : null;
    if (look && typeof look.length === 'string') config.look.length = look.length;

    const buddy = saved?.buddy && typeof saved.buddy === 'object' ? saved.buddy : null;
    if (!buddy) return;
    if (typeof buddy.enabled === 'boolean') config.buddy.enabled = buddy.enabled;
    // 可见性：新字段 visible；旧版本只有 enabled，把"关掉浮窗"迁移成"隐藏"。
    if (typeof buddy.visible === 'boolean') config.buddy.visible = buddy.visible;
    else if (typeof buddy.enabled === 'boolean') config.buddy.visible = buddy.enabled;
    if (typeof buddy.asset === 'string') config.buddy.asset = buddy.asset;
    if (Number.isFinite(Number(buddy.size)) && Number(buddy.size) > 0) config.buddy.size = Number(buddy.size);
    if (Number.isFinite(Number(buddy.fontSize)) && Number(buddy.fontSize) > 0) config.buddy.fontSize = Number(buddy.fontSize);
    if (buddy.hotkeys && typeof buddy.hotkeys === 'object') {
      if (typeof buddy.hotkeys.look === 'string' && buddy.hotkeys.look.trim() !== '') {
        config.buddy.hotkeys.look = buddy.hotkeys.look.trim();
      }
      if (typeof buddy.hotkeys.ask === 'string' && buddy.hotkeys.ask.trim() !== '') {
        config.buddy.hotkeys.ask = buddy.hotkeys.ask.trim();
      }
      if (typeof buddy.hotkeys.collect === 'string' && buddy.hotkeys.collect.trim() !== '') {
        config.buddy.hotkeys.collect = buddy.hotkeys.collect.trim();
      }
    }
  }

  /** 把「桌宠是否可见」写进 settings.json（菜单隐藏、设置页开关、显示接口共用）。 */
  function persistVisibility(visible) {
    try {
      const saved = readSettings();
      const next = { ...saved, buddy: { ...(saved.buddy ?? {}), visible: visible === true } };
      delete next.buddy.enabled;
      mkdirSync(dirname(settingsPath()), { recursive: true });
      writeFileSync(settingsPath(), `${JSON.stringify(next, null, 2)}\n`);
    } catch (error) {
      logger?.warn?.(`[dsh-companion-journal] 保存桌宠可见性失败：${reasonOf(error)}`);
    }
  }

  /** 浮窗控制器：设置页改立绘/开关时用它重启。 */
  let buddyHandle = null;

  /** 按当前配置重建浮窗（改立绘后调用）。 */
  function restartBuddy() {
    try {
      buddyHandle?.dispose?.();
    } catch {
      /* 忽略 */
    }
    buddyHandle = null;
    if (config.buddy.enabled !== true) return;
    try {
      const prepared = syncBuddyCopy(logger);
      setSurface(buddyPaths());
      buddyHandle = startBuddy({
        binPath: prepared.binPath,
        assetPath: prepared.assetPath,
        paths: buddyPaths(),
        logger,
        size: Number(config.buddy.size) > 0 ? Number(config.buddy.size) : 160,
        fontSize: Number(config.buddy.fontSize) > 0 ? Number(config.buddy.fontSize) : 13,
        maxBubbleChars: Number(config.buddy.maxBubbleChars) > 0 ? Number(config.buddy.maxBubbleChars) : 400,
        debugHitbox: config.buddy.debugHitbox === true,
        hotkeys: {
          look: String(config.buddy.hotkeys?.look ?? 'F8'),
          ask: String(config.buddy.hotkeys?.ask ?? 'F7'),
          collect: String(config.buddy.hotkeys?.collect ?? 'F9'),
        },
        onPress: handleBuddyPress,
      });
    } catch (error) {
      logger?.warn?.(`[dsh-companion-journal] 重建浮窗失败：${reasonOf(error)}`);
    }
  }

  /** 刷新常驻气泡：显示当前张数与两个动作。 */
  async function showCollectBubble(ctx, count) {
    try {
      await say(ctx, `● 多画面 · 已收 ${count} 张`, {
        sticky: true,
        compact: false,
        actions: [
          { id: 'collect-end', label: '结束并看' },
          // 等于 F7：带上问题结束这一组。收集过程中的气泡是常驻的，
          // 所以用户不用记热键——想提问直接点这里。
          { id: 'collect-ask', label: '提问' },
          { id: 'collect-cancel', label: '取消' },
        ],
      });
    } catch {
      /* 浮窗没起来就算了 */
    }
  }

  /** 结束收集并分析这一组。 */
  /**
   * 多画面收集收尾。
   *
   * 注意：调用方多是 `void finishCollection(...)`（事件回调里不方便 await），
   * 所以它**自己**必须兜住所有异常——一旦 reject 出去就是未捕获的 Promise，
   * 宿主会以 "fatal load failure" 直接退出。2026-11-07 就因为它把整个应用崩了。
   */
  async function finishCollection(ctx, options = {}) {
    try {
      return await finishCollectionInner(ctx, options);
    } catch (error) {
      const reason = reasonOf(error);
      logger.warn?.(`[dsh-companion-journal] 多画面分析失败：${reason}`);
      await say(ctx, `这组看不了：${reason.slice(0, 60)}`, { compact: true }).catch(() => {});
      return { ok: false, reason };
    }
  }

  async function finishCollectionInner(ctx, { question = '' } = {}) {
    const items = collection.stop();
    // 收集时 OCR 是后台跑的：分析前先等齐（每张都自己兜底，失败就当没有文字）。
    await Promise.all(
      items.map(async (item) => {
        if (!item.pendingOcr) return;
        try {
          const ocr = await item.pendingOcr;
          item.text = String(ocr?.text ?? '');
        } catch {
          item.text = '';
        }
      }),
    );
    if (items.length === 0) {
      await say(ctx, '还没有截图', { compact: true }).catch(() => {});
      return { ok: false, reason: 'empty' };
    }
    await say(ctx, `看这 ${items.length} 张…`, { compact: true }).catch(() => {});
    const result = await describeCollection({
      ctx,
      items,
      question,
      length: config?.look?.length ?? 'normal',
      logger,
    });
    if (!result.ok) {
      await say(ctx, `这组看不了：${String(result.reason ?? '').slice(0, 60)}`, { compact: true }).catch(() => {});
      return result;
    }
    const record = history?.append({
      kind: 'multi',
      mode: 'multi',
      app: items[0]?.target?.appName ?? '',
      title: items[0]?.target?.windowTitle ?? '',
      question,
      answer: result.text,
      // merged OCR 放 ocr（只用于搜索），text 留空：它不是「选中的文字」。
      text: '',
      ocr: items.map((item) => String(item.text ?? '')).join('\n\n').slice(0, 8000),
      images: items.map((item) => ({ thumb: item.thumb, image: item.image, text: String(item.text ?? '').slice(0, 4000) })),
    });
    await say(ctx, result.text, { recordId: record?.id }).catch(() => {});
    return result;
  }

  /** 浮窗发来的点击事件。 */
  function handleBuddyPress({ action, id, cursorOverPet = false, awayScreen = null }) {
    lastBuddyAction = { action: String(action), at: Date.now() };

    // 多画面收集的三个动作：开/关、结束、取消。
    if (action === 'collect') {
      if (collection.active()) {
        void finishCollection(ctx);
      } else {
        collection.start();
        void showCollectBubble(ctx, 0);
      }
      return;
    }
    if (action === 'collect-end') {
      void finishCollection(ctx);
      return;
    }
    // 内部能力：`watch-window:<id>` 锁指定窗口（调试、以及以后挂到「录这个窗户」菜单上）。
    if (action.startsWith('watch-window:')) {
      const id = Number(action.slice('watch-window:'.length));
      watchSegmentExpanded = false;
      void prepareWatch({ windowId: Number.isFinite(id) ? id : 0 }).then((result) => {
        if (!result.ok) void say(ctx, `开不了：${result.reason}`, { compact: true }).catch(() => {});
      });
      return;
    }
    if (action === 'watch-toggle') {
      if (watch.isActive()) {
        void say(ctx, '正在录制中（停止在气泡上）', { compact: true }).catch(() => {});
      } else {
        watchSegmentExpanded = false;
        void prepareWatch().then((result) => {
          if (!result.ok) void say(ctx, `开不了：${result.reason}`, { compact: true }).catch(() => {});
        });
      }
      return;
    }
    // 浮窗监听应用激活后发来的事件：准备阶段跟随活动窗口（录制中忽略）。
    // 菜单里点了「隐藏」：收窗口 + 记住这个状态（下次启动仍然是隐藏的）。
    if (action === 'hide-pet') {
      config.buddy.visible = false;
      persistVisibility(false);
      hidePet(buddyPaths());
      return;
    }
    if (action === 'front-changed') {
      void refreshPendingTarget().catch(() => {});
      return;
    }
    if (action === 'watch-begin') {
      // 未开始状态下才有意义；录制中按不到这个 id。
      if (!watchPending) {
        void say(ctx, '已经开始了', { compact: true }).catch(() => {});
        return;
      }
      watchSegmentExpanded = false;
      void beginWatch().catch((error) => logger.warn?.(`[dsh-companion-journal] 开始看一阵失败：${reasonOf(error)}`));
      return;
    }
    if (action === 'watch-pause') {
      watch.pause();
      return;
    }
    if (action === 'watch-resume') {
      watch.resume();
      return;
    }
    if (action === 'watch-segment-toggle') {
      watchSegmentExpanded = !watchSegmentExpanded;
      // 立刻重画一次：否则要等下一拍心跳才看到效果。
      void updateWatchBubble(watch.status()).catch(() => {});
      return;
    }
    // 采样率菜单：`watch-interval:<毫秒>` 直接设定，点哪档就是哪档。
    if (action.startsWith('watch-interval:')) {
      const ms = Number(action.slice('watch-interval:'.length));
      if (watchPending) {
        // 还没开始：只记下选择，开始时带上。
        if (INTERVALS.includes(ms)) watchPending.intervalMs = ms;
        void showWatchIdleBubble().catch(() => {});
        return;
      }
      const result = watch.setIntervalMs(ms);
      if (!result.ok) void say(ctx, '现在没有在录制', { compact: true }).catch(() => {});
      return;
    }
    // 兼容旧按钮（循环切档），保留给还没更新的浮窗二进制。
    if (action === 'watch-interval') {
      watch.cycleInterval();
      return;
    }
    if (action === 'watch-stop') {
      void watch
        .stop()
        .then((result) => {
          if (result.ok) void say(ctx, '已停止', { recordId: result.record?.id }).catch(() => {});
          else if (result.reason === 'discarded') void say(ctx, '这一阵丢弃了', { compact: true }).catch(() => {});
        })
        .catch((error) => logger.warn?.(`[dsh-companion-journal] 停止看一阵失败：${reasonOf(error)}`));
      return;
    }
    if (action === 'watch-discard') {
      void watch.discard().then(() => say(ctx, '这一阵丢弃了', { compact: true }).catch(() => {}));
      return;
    }
    if (action === 'notice-ok') {
      hideBubble(buddyPaths());
      return;
    }
    if (action === 'collect-cancel') {
      collection.cancel();
      void say(ctx, '已取消', { compact: true }).catch(() => {});
      return;
    }
    if (action === 'look' || action === 'ask' || action === 'collect-ask') {
      // ask 目前先走和 look 一样的路径；F7 的提问弹窗接上后再分开。
      // 点桌宠时鼠标已经落在桌宠上：「光标在哪块屏」失去意义，改用「点之前光标停在哪块屏」。
      // 不这么做的话，点击和快捷键在「桌面截图」上会给出不同结果（实测）。
      void runLook({
        // collect-ask 与热键 F7 同义：先问一句，再带着问题结束收集。
        mode: action === 'ask' || action === 'collect-ask' ? 'f7' : 'f8',
        desktopScreen: cursorOverPet && awayScreen ? awayScreen : null,
      }).catch((error) => logger.warn?.(`[dsh-companion-journal] 看一眼失败：${reasonOf(error)}`));
      return;
    }
    if (action === 'open' || action === 'panel') {
      pendingOpen = { recordId: action === 'open' ? id : '', panel: action === 'panel', at: Date.now() };
      notifyBuddy(pendingOpen);
      focusDsh(logger);
    }
  }

  /**
   * 浮窗的三个文件：位置、气泡、点击。固定放在 DSH_HOME 下，重启后不变。
   */
  function buddyPaths() {
    const base = dirname(hotkeyEventsPath());
    return {
      statePath: join(base, 'buddy.state.json'),
      sayPath: join(base, 'buddy.say.json'),
      pressPath: join(base, 'buddy.press.jsonl'),
      askRequestPath: join(base, 'buddy.ask.request.json'),
      askResponsePath: join(base, 'buddy.ask.response.json'),
      recenterPath: join(base, 'buddy.recenter.json'),
    };
  }

  /**
   * 把浮窗二进制和立绘同步到 DSH_HOME 下再启动。
   *
   * 理由和桥一样：直接从 ~/Documents 拉起会被 TCC 拦（"Operation not permitted"），
   * 复制到 DSH_HOME 后就不在受保护目录里了。
   */
  function syncBuddyCopy(logger) {
    const base = dirname(hotkeyEventsPath());
    const binDir = join(base, 'bin');
    const assetDir = join(base, 'assets');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(assetDir, { recursive: true });

    const sourceBin = join(pluginRoot, 'buddy', 'bin', 'dsh-buddy');
    const targetBin = join(binDir, 'dsh-buddy');

    // 立绘：配置了 buddy.asset 就用用户的图，否则用包内自带的那张。
    // 目标名固定，浮窗按路径取；用户换图后 mtime 变化会自动重新复制。
    const configured = String(config.buddy.asset ?? '').trim();
    const userAsset = configured === '' ? '' : configured.replace(/^~(?=\/)/, process.env.HOME ?? '~');
    const useUserAsset = userAsset !== '' && existsSync(userAsset);
    if (userAsset !== '' && !useUserAsset) {
      logger?.warn?.(`[dsh-companion-journal] buddy.asset 指向的图不存在：${userAsset}，先用包内自带的立绘`);
    }
    const sourceAsset = useUserAsset ? userAsset : join(pluginRoot, 'assets', 'buddy', 'character.png');
    const ext = (sourceAsset.match(/\.[a-zA-Z0-9]+$/) ?? [''])[0].toLowerCase() || '.png';
    const targetAsset = join(assetDir, `character${ext}`);

    for (const [from, to, mode] of [
      [sourceBin, targetBin, 0o755],
      [sourceAsset, targetAsset, 0o644],
    ]) {
      try {
        const needsCopy = !statSync(to, { throwIfNoEntry: false }) ||
          statSync(from).mtimeMs > statSync(to).mtimeMs ||
          statSync(from).size !== statSync(to).size;
        if (needsCopy) {
          copyFileSync(from, to);
          chmodSync(to, mode);
        }
      } catch (error) {
        logger?.warn?.(`[dsh-companion-journal] 同步浮窗资源失败（${from}）：${reasonOf(error)}`);
      }
    }
    return { binPath: targetBin, assetPath: targetAsset };
  }

  /** 把 DSH 窗口拉到前台（点气泡后要让你看到面板）。 */
  function focusDsh(logger) {
    try {
      const child = spawn('open', ['-b', 'com.deepseek.dsh'], { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
    } catch (error) {
      logger?.warn?.(`[dsh-companion-journal] 唤起 DSH 失败：${reasonOf(error)}`);
    }
  }

  /** 热键状态：注册成功与否、用了哪个加速键、失败原因。 */
  const hotkey = { registered: false, accelerator: '', error: null, presses: 0, busy: false, dropped: 0, timedOut: 0, lastMs: 0 };
  /** 最近一次「看一眼」读到的选中文字情况（诊断「选中了却走截图」用）。 */
  let lastSelection = null;
  /** 点气泡后要打开/定位的记录（客户端下次拉取时消费并清空）。 */
  let pendingOpen = null;
  /** 看一阵：控制条上方的段输出气泡是否展开（录制期间保持）。 */
  let watchSegmentExpanded = false;

  /** 已经提醒过重启的「客户端版本」：同一个版本只弹一次，点「知道了」也不再弹。 */
  let restartNoticedFor = '';
  /** 多画面收集：开始 → 每次 F8 加一张 → 结束一起分析。 */
  const collection = createCollection();
  /** 最近一次浮窗动作（诊断用：确认右键菜单的点击到底有没有到宿主）。 */
  let lastBuddyAction = null;
  /** SSE 订阅者：点气泡时直接推给页面，不用轮询。 */
  const buddyListeners = new Set();

  /** 通知页面「该打开哪条记录了」。 */
  function notifyBuddy(payload) {
    for (const listener of [...buddyListeners]) {
      try {
        listener(payload);
      } catch {
        buddyListeners.delete(listener);
      }
    }
  }

  // ── 工具 ────────────────────────────────────────────────────────────────
  ctx.effect(() => {
    const disposers = [];
    try {
      const tools = createTools({ ctx, config, observer, logger });
      for (const tool of tools) {
        disposers.push(ctx.tools.register(tool));
      }
      logger.info?.(`[dsh-companion-journal] 已注册 ${tools.length} 个工具`);
    } catch (error) {
      // 工具注册失败不影响旁观：这两个能力互相独立。
      logger.error?.(`[dsh-companion-journal] 工具注册失败：${reasonOf(error)}`);
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* 卸载时的二次失败没有意义 */
        }
      }
    };
  });

  // ── 斜杠命令 ────────────────────────────────────────────────────────────
  ctx.effect(() => {
    try {
      const dispose = ctx.commands.register({
        name: 'companion',
        description: '陪伴层：status 看状态 / start 暂停旁观 / watch 看一阵 / watch-stop 停止 / once 立刻看一次',
        input: { hint: '[status|watch|watch-stop|start|pause|once]（留空 = status）' },
        handler: async ({ rawInput }) => {
          const action = String(rawInput ?? '').trim().toLowerCase() || 'status';
          try {
            if (action === 'watch' || action.startsWith('watch ')) {
              if (watch.isActive()) {
                return { kind: 'success', text: '看一阵正在录制（暂停 / 停止在气泡上）' };
              }
              // `/companion watch 160134` 可以直接锁某个窗口（调试或「就录这个窗户」）。
              const wanted = Number(action.split(' ')[1] ?? 0);
              watchSegmentExpanded = false;
              const prepared = await prepareWatch({ windowId: Number.isFinite(wanted) ? wanted : 0 });
              return prepared.ok
                ? { kind: 'success', text: '看一阵已就绪：在气泡上按「开始」才会采集' }
                : { kind: 'error', text: `看一阵没开起来：${prepared.reason}` };
            }
            if (action === 'watch-stop') {
              const result = await watch.stop();
              return result.ok
                ? { kind: 'success', text: `看一阵已停止：${result.stats.windows} 段，${formatDuration(result.stats.durationMs)}` }
                : { kind: 'error', text: '当前没有在录制' };
            }
            if (action === 'start') {
              observer.start();
              return { kind: 'success', text: '旁观已开启：场景变化时桌宠会说一句（有频率上限）' };
            }
            if (action === 'pause') {
              observer.pause();
              return { kind: 'success', text: '旁观已暂停' };
            }
            if (action === 'once') {
              const outcome = await observer.tick({ force: true });
              return {
                kind: outcome.said ? 'success' : 'error',
                text: outcome.said ? `桌宠说了：${outcome.said}` : `这次没开口：${outcome.skipped ?? 'unknown'}`,
              };
            }
            const status = observer.status();
            const bits = [
              `旁观 ${status.enabled ? '开启' : '关闭'}`,
              `采样 ${status.ticks} 次`,
              status.lastScene ? `上次场景 ${status.lastScene.appName}` : '还没采过样',
              status.lastSkip ? `上次跳过 ${status.lastSkip.reason}` : '',
            ].filter(Boolean);
            // 首次安装最常问的就是「为什么截不了图」：状态里直接回权限。
            try {
              const perms = await permissionsSnapshot();
              const label = (value) => (value === true ? '已授权' : value === false ? '未授权' : '未知');
              bits.push(`权限 屏幕录制${label(perms.screenRecording)} / 辅助功能${label(perms.accessibility)}`);
            } catch {
              /* 权限查询失败不影响 status */
            }
            return { kind: 'success', text: bits.join('；') };
          } catch (error) {
            return { kind: 'error', text: `陪伴层出错：${String(error?.message ?? error)}` };
          }
        },
      });
      return () => {
        try {
          dispose?.();
        } catch {
          /* 忽略 */
        }
      };
    } catch (error) {
      logger.warn?.(`[dsh-companion-journal] 命令注册失败：${reasonOf(error)}`);
      return () => {};
    }
  });

  // ── 权限：查询 / 主动请求 / 打开系统设置 ─────────────────────────────────
  // 用户第一次装完插件时，屏幕录制与辅助功能都不会自动授权；这组接口让设置页
  // 能给出「已授权/未授权」和两个按钮，而不是等某次截图失败后自己猜。
  const PERMISSION_PANES = {
    screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  };

  /** 只查询、不弹窗。bridge 不可用时返回 null，页面显示「未知」而不是「未授权」。 */
  async function permissionsSnapshot() {
    if (process.platform !== 'darwin') {
      return { ok: false, platform: process.platform, screenRecording: null, accessibility: null, reason: '仅 macOS 支持系统权限' };
    }
    try {
      const value = await bridgeTrust(ctx);
      return {
        ok: true,
        screenRecording: Boolean(value.screenRecording),
        accessibility: Boolean(value.accessibility),
        automation: 'per-app',
        restartRequired: !(value.screenRecording && value.accessibility),
      };
    } catch (error) {
      return { ok: false, screenRecording: null, accessibility: null, reason: reasonOf(error) };
    }
  }

  /** 主动触发系统授权框；屏幕录制与辅助功能各一个。 */
  async function requestPermission(kind) {
    if (kind !== 'screen' && kind !== 'accessibility') return { ok: false, reason: '未知的权限类型' };
    if (process.env.DSH_COMPANION_NO_PERMISSION_PROMPT === '1') {
      return { ...(await permissionsSnapshot()), ok: true, requested: false };
    }
    try {
      const value = kind === 'screen'
        ? await requestScreenPermission(ctx)
        : await requestAccessibilityPermission(ctx);
      return {
        ok: true,
        requested: true,
        screenRecording: Boolean(value.screenRecording),
        accessibility: Boolean(value.accessibility),
        restartRequired: true,
      };
    } catch (error) {
      return { ...(await permissionsSnapshot()), ok: false, requested: false, reason: reasonOf(error) };
    }
  }

  /** 打开系统设置的对应面板。深链在 macOS 13+ 仍然有效。 */
  function openPermissionPane(kind) {
    const target = PERMISSION_PANES[kind];
    if (!target) return { ok: false, reason: '未知的权限类型' };
    if (process.env.DSH_COMPANION_NO_OPEN === '1') return { ok: true, url: target, opened: false };
    try {
      const child = spawn('open', [target], { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      return { ok: true, url: target, opened: true };
    } catch (error) {
      return { ok: false, reason: reasonOf(error) };
    }
  }

  // ── 本机只读状态接口：/state 给诊断与面板用 ──────────────────────────────
  let bridge = { ok: false };
  void bridgeStatus().then((status) => {
    bridge = status;
    if (!status.ok) logger.warn?.(`[dsh-companion-journal] ${status.hint}`);
  });

  ctx.effect(() => {
    try {
      const dispose = ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_SEGMENT,
        handler: async (req, res) => {
          const send = (status, payload) => {
            if (res.destroyed || res.writableEnded) return;
            const body = JSON.stringify(payload);
            res.writeHead(status, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
              // 只服务本机同页：显式禁止跨源读，避免被网页探测。
              'Access-Control-Allow-Origin': 'null',
            });
            res.end(body);
          };
          const url = new URL(req.url ?? '/', 'http://localhost');
          const rest = url.pathname.slice(ROUTE_SEGMENT.length).replace(/^\/+/, '');
          try {
            if (rest === '' || rest === 'state') {
              // 存活会话数：用于确认残留 agent 是否真的被释放（>0 就会干扰客户端草稿）。
              let companionLive = 0;
              try {
                companionLive = (ctx.get('agents')?.list?.() ?? []).filter((a) => String(a?.id ?? '').startsWith('companion-')).length;
              } catch {
                companionLive = -1;
              }
              send(200, {
                ok: true,
                version: codeVersion(),
                menu,
                hotkey,
                lastSelection,
                companionLive,
                observer: observer.status(),
                bridge,
                config: {
                  observeEnabled: config.observe.enabled,
                  intervalMs: config.observe.intervalMs,
                  buddyRunning: buddyState.running,
                buddyListeners: buddyListeners.size,
                lastBuddyAction,
                buddyEventsSeen: buddyState.eventsSeen,
                },
              });
              return;
            }
            // 图片：按记录 id 取，路径不暴露给前端，避免任意文件读取。
            if ((rest.startsWith('history/thumb/') || rest.startsWith('history/image/')) && req.method === 'GET') {
              const kind = rest.startsWith('history/image/') ? 'image' : 'thumb';
              const prefix = kind === 'image' ? 'history/image/' : 'history/thumb/';
              const id = decodeURIComponent(rest.slice(prefix.length));
              const record = history.list({ limit: 1000 }).items.find((r) => r.id === id);
              // 多画面记录的第 N 张：?index=N 取 images[N]（缺省 0 = 第一张）。
              // 看一阵的拼图：?sheet=N 取 timeline[N].sheet（每段的画面证据）。
              const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
              const sheetParam = params.get('sheet');
              if (sheetParam !== null) {
                const sheetIndex = Number(sheetParam);
                const win = Array.isArray(record?.timeline)
                  ? record.timeline[Math.max(0, Math.min(record.timeline.length - 1, Number.isFinite(sheetIndex) ? sheetIndex : 0))]
                  : null;
                const rel = String(win?.sheet ?? '');
                if (!rel) {
                  send(404, { ok: false, error: 'no-sheet' });
                  return;
                }
                try {
                  const { readFile } = await import('node:fs/promises');
                  const { join } = await import('node:path');
                  const bytes = await readFile(join(history.file.replace(/\/[^/]+$/, ''), rel));
                  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=86400' });
                  res.end(bytes);
                } catch {
                  send(404, { ok: false, error: 'sheet-missing' });
                }
                return;
              }
              const indexParam = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('index') ?? 0);
              const picked =
                Array.isArray(record?.images) && record.images.length > 0
                  ? record.images[Math.max(0, Math.min(record.images.length - 1, Number.isFinite(indexParam) ? indexParam : 0))]
                  : null;
              const rel = (kind === 'image' ? picked?.image || record?.image : picked?.thumb || record?.thumb) ?? '';
              if (!rel) {
                send(404, { ok: false, error: 'no-thumb' });
                return;
              }
              try {
                const { readFile } = await import('node:fs/promises');
                const { join } = await import('node:path');
                const bytes = await readFile(join(history.file.replace(/\/[^/]+$/, ''), rel));
                const type = rel.endsWith('.jpg') || rel.endsWith('.jpeg')
                  ? 'image/jpeg'
                  : rel.endsWith('.webp')
                    ? 'image/webp'
                    : 'image/png';
                res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' });
                res.end(bytes);
              } catch {
                send(404, { ok: false, error: 'thumb-missing' });
              }
              return;
            }
            // 权限状态：设置页打开时刷新，也可单独轮询（不弹窗）。
            if (rest === 'permissions' && req.method === 'GET') {
              send(200, await permissionsSnapshot());
              return;
            }
            // 主动请求授权：会弹系统框。用户拒绝过之后系统不再弹，页面再引导去设置。
            if (rest === 'permissions/request' && req.method === 'POST') {
              let body = {};
              try {
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
              } catch {
                send(400, { ok: false, error: 'bad-json' });
                return;
              }
              send(200, await requestPermission(String(body?.kind ?? '')));
              return;
            }
            // 直接打开系统设置的对应面板（屏幕录制 / 辅助功能 / 自动化）。
            if (rest === 'permissions/open' && req.method === 'POST') {
              let body = {};
              try {
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
              } catch {
                send(400, { ok: false, error: 'bad-json' });
                return;
              }
              const kind = String(body?.kind ?? '');
              if (!PERMISSION_PANES[kind]) {
                send(400, { ok: false, error: 'bad-kind' });
                return;
              }
              send(200, openPermissionPane(kind));
              return;
            }
            // 设置页：读/写插件自己的设置（存 settings.json，覆盖 patch 里的同名项）。
            if (rest === 'settings' && req.method === 'GET') {
              send(200, {
                ok: true,
                settings: {
                  look: { length: String(config.look?.length ?? 'normal') },
                  buddy: {
                    visible: config.buddy.visible !== false,
                    asset: String(config.buddy.asset ?? ''),
                    size: Number(config.buddy.size) || 160,
                    fontSize: Number(config.buddy.fontSize) || 13,
                    hotkeys: {
                      look: String(config.buddy.hotkeys?.look ?? 'F8'),
                      ask: String(config.buddy.hotkeys?.ask ?? 'F7'),
                      collect: String(config.buddy.hotkeys?.collect ?? 'F9'),
                    },
                  },
                },
                persona: readPersona(),
                prompt: promptSettingsPayload(),
                permissions: await permissionsSnapshot(),
                status: {
                  running: buddyState.running,
                  assetPath: (() => {
                    try {
                      return syncBuddyCopy(logger).assetPath;
                    } catch {
                      return '';
                    }
                  })(),
                  hotkey: hotkey.registered ? hotkey.accelerator || config.hotkey.spec : '',
                },
              });
              return;
            }
            if (rest === 'settings' && req.method === 'POST') {
              let body = {};
              try {
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
              } catch {
                send(400, { ok: false, error: 'bad-json' });
                return;
              }
              const saved = readSettings();
              const next = { ...saved };

              // look：只认白名单里的预设 id，其它值忽略。
              const nextLook = { ...(saved.look ?? {}) };
              if (body?.look && typeof body.look === 'object') {
                const length = String(body.look.length ?? '').trim();
                if (['short', 'normal', 'detailed'].includes(length)) nextLook.length = length;
              }
              next.look = nextLook;

              // buddy：逐项校验后合并，避免一次保存把没提到的字段清空。
              const buddyIn = body?.buddy && typeof body.buddy === 'object' ? body.buddy : {};
              const nextBuddy = { ...(saved.buddy ?? {}) };
              if (typeof buddyIn.visible === 'boolean') nextBuddy.visible = buddyIn.visible;
              if (typeof buddyIn.asset === 'string') nextBuddy.asset = buddyIn.asset.trim();
              if (Number.isFinite(Number(buddyIn.size))) {
                nextBuddy.size = Math.max(64, Math.min(512, Math.round(Number(buddyIn.size))));
              }
              if (Number.isFinite(Number(buddyIn.fontSize))) {
                nextBuddy.fontSize = Math.max(10, Math.min(24, Math.round(Number(buddyIn.fontSize))));
              }
              if (buddyIn.hotkeys && typeof buddyIn.hotkeys === 'object') {
                const hotkeys = { ...(nextBuddy.hotkeys ?? {}) };
                const lookKey = String(buddyIn.hotkeys.look ?? '').trim();
                const askKey = String(buddyIn.hotkeys.ask ?? '').trim();
                const collectKey = String(buddyIn.hotkeys.collect ?? '').trim();
                if (lookKey) hotkeys.look = lookKey;
                if (askKey) hotkeys.ask = askKey;
                if (collectKey) hotkeys.collect = collectKey;
                nextBuddy.hotkeys = hotkeys;
              }
              next.buddy = nextBuddy;

              try {
                mkdirSync(dirname(settingsPath()), { recursive: true });
                writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
              } catch (error) {
                send(200, { ok: false, reason: `写入设置失败：${reasonOf(error)}` });
                return;
              }

              if (typeof body.persona === 'string') {
                try {
                  mkdirSync(defaultBaseDir(), { recursive: true });
                  writeFileSync(personaPath(), String(body.persona).slice(0, 4000));
                } catch (error) {
                  send(200, { ok: false, reason: `保存人设失败：${reasonOf(error)}` });
                  return;
                }
              }

              // prompt：每个字段单独校验，空字符串 = 删除该覆盖、回到内置默认。
              if (body?.prompt && typeof body.prompt === 'object') {
                const input = body.prompt;
                // 兼容旧字段名 core；新字段是 text（规则段全文，含密度那句）。
                const rawText = input.text !== undefined ? input.text : input.core;
                const clean = (value) => String(value ?? '').trim().slice(0, 8000);
                const text = clean(rawText);
                const chat = clean(input.chat);
                const nextPrompt = {};
                // 跟内置模板一字不差就不落盘：以后改默认模板，用户能自动跟上。
                if (text !== '' && text !== clean(defaultLookRules())) nextPrompt.core = text;
                if (chat !== '' && chat !== clean(promptDefaults().chat)) nextPrompt.chat = chat;
                try {
                  mkdirSync(dirname(promptPath()), { recursive: true });
                  if (Object.keys(nextPrompt).length === 0) {
                    // 全是默认：直接把文件清成空对象，比留着历史残渣更好懂。
                    writeFileSync(promptPath(), '{}\n');
                  } else {
                    writeFileSync(promptPath(), `${JSON.stringify(nextPrompt, null, 2)}\n`);
                  }
                  applyPromptOverrides();
                } catch (error) {
                  send(200, { ok: false, reason: `保存提示词失败：${reasonOf(error)}` });
                  return;
                }
              }

              applySettings();
              restartBuddy();
              // 菜单里「隐藏」只是把窗口 orderOut 了，进程还在；这里显式要求显示，
              // 用户不必为了把桌宠找回来去重启 DSH（实测踩过：隐藏后设置页开关点了没反应）。
              if (config.buddy.visible === false) hidePet(buddyPaths());
              else if (config.buddy.enabled === true) showPet(buddyPaths());
              send(200, {
                ok: true,
                running: buddyState.running,
                asset: String(config.buddy.asset ?? ''),
                prompt: promptSettingsPayload(),
              });
              return;
            }
            // 桌宠显示/隐藏：隐藏后右建菜单点不到，只能靠这里恢复。
            if (rest === 'buddy/show' && req.method === 'POST') {
              config.buddy.visible = true;
              persistVisibility(true);
              const result = showPet(buddyPaths());
              send(200, { ok: result.ok, running: buddyState.running, reason: result.reason });
              return;
            }
            if (rest === 'buddy/hide' && req.method === 'POST') {
              config.buddy.visible = false;
              persistVisibility(false);
              const result = hidePet(buddyPaths());
              send(200, { ok: result.ok, running: buddyState.running, reason: result.reason });
              return;
            }
            // 设置页的「重置人物位置」：写一个请求文件，浮窗轮询到就把自己挪回主屏右下角。
            if (rest === 'buddy/recenter' && req.method === 'POST') {
              try {
                mkdirSync(dirname(buddyPaths().recenterPath), { recursive: true });
                writeFileSync(buddyPaths().recenterPath, JSON.stringify({ at: Date.now() }));
                send(200, { ok: true });
              } catch (error) {
                send(200, { ok: false, reason: reasonOf(error) });
              }
              return;
            }
            // 设置页的「选择…」：原生选图面板（NSOpenPanel）。
            // 实测它能弹出来，只是我这个终端进程看不到（截图拍不到、也不阻塞报错），
            // 所以保留原生为主、目录浏览为备选。
            if (rest === 'buddy/pick' && req.method === 'GET') {
              try {
                const picked = await pickImageFile(ctx);
                if (!picked?.ok) {
                  send(200, { ok: false, reason: String(picked?.reason ?? '选择器不可用') });
                  return;
                }
                send(200, { ok: true, path: String(picked.path ?? ''), cancelled: Boolean(picked.cancelled) });
              } catch (error) {
                send(200, { ok: false, reason: reasonOf(error) });
              }
              return;
            }
            // 备选：读目录给页面自己渲染（原生面板在某些无窗口环境弹不出来时用）。
            // 说明：读目录请求路径用 /buddy/browse
            // 实测 NSOpenPanel 会静默卡住）。这里只列目录和图片，交给页面自己渲染。
            if (rest === 'buddy/browse' && req.method === 'GET') {
              try {
                const { readdirSync } = await import('node:fs');
                const { homedir } = await import('node:os');
                const { resolve: resolvePath } = await import('node:path');
                const requested = String(url.searchParams.get('dir') ?? '').trim();
                const dir = resolvePath(requested === '' ? homedir() : requested.replace(/^~(?=\/)/, homedir()));
                const entries = readdirSync(dir, { withFileTypes: true })
                  .filter((entry) => !entry.name.startsWith('.'))
                  .map((entry) => ({
                    name: entry.name,
                    dir: entry.isDirectory(),
                    path: join(dir, entry.name),
                    image: /\.(png|jpe?g|webp)$/i.test(entry.name),
                  }))
                  .filter((entry) => entry.dir || entry.image)
                  .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
                  .slice(0, 300);
                const parent = dir === '/' ? '' : resolvePath(dir, '..');
                send(200, { ok: true, dir, parent, entries });
              } catch (error) {
                send(200, { ok: false, reason: `读目录失败：${reasonOf(error)}` });
              }
              return;
            }
            // 立绘预览：设置页要看到当前用的是哪张图（按 mtime 破坏缓存）。
            if (rest === 'buddy/asset' && req.method === 'GET') {
              try {
                const { assetPath } = syncBuddyCopy(logger);
                const ext = (assetPath.match(/\.[a-zA-Z0-9]+$/) ?? ['.png'])[0].toLowerCase();
                const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
                const bytes = readFileSync(assetPath);
                res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': 'null' });
                res.end(bytes);
              } catch (error) {
                send(404, { ok: false, reason: reasonOf(error) });
              }
              return;
            }
            // 客户端上报自己那份 bundle 的版本：宿主比它新就说明「必须重启客户端」。
            // 只在 apply 时上报一次，不轮询。
            if (rest === 'client-version' && req.method === 'POST') {
              let body = {};
              try {
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
              } catch {
                send(400, { ok: false, error: 'bad-json' });
                return;
              }
              const clientVersion = String(body?.version ?? '').trim();
              // 比的是「客户端 bundle 版本」，不是包版本：宿主-only 发版不该让用户白重启。
              const expected = CLIENT_VERSION_EXPECTED || codeVersion();
              const needsRestart = clientVersion !== '' && clientVersion !== expected;
              if (needsRestart && restartNoticedFor !== clientVersion) {
                restartNoticedFor = clientVersion;
                // 常驻气泡 + 一个「知道了」：这是用户唯一会看的提示位置。
                void say(ctx, '有新版本，重启客户端生效', {
                  sticky: true,
                  compact: true,
                  actions: [{ id: 'notice-ok', label: '知道了' }],
                }).catch(() => {});
              }
              send(200, { ok: true, hostVersion: codeVersion(), expectedClientVersion: CLIENT_VERSION_EXPECTED, clientVersion, needsRestart });
              return;
            }
            // 事件流：点气泡时把「打开这条记录」推给页面（SSE，不轮询）。
            if (rest === 'buddy/events' && req.method === 'GET') {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-store',
                Connection: 'keep-alive',
                'Access-Control-Allow-Origin': 'null',
              });
              res.write(': connected\n\n');
              const push = (payload) => {
                if (res.destroyed || res.writableEnded) return;
                res.write(`data: ${JSON.stringify(payload)}\n\n`);
              };
              buddyListeners.add(push);
              // 心跳：防止中间层把空闲连接掐掉。
              const beat = setInterval(() => {
                if (res.destroyed || res.writableEnded) return;
                res.write(': beat\n\n');
              }, 25000);
              beat?.unref?.();
              // 已经攒着一条 pending 的话，连上就补发，避免错过。
              if (pendingOpen?.recordId) push({ recordId: pendingOpen.recordId, at: pendingOpen.at });
              req.on('close', () => {
                clearInterval(beat);
                buddyListeners.delete(push);
              });
              return;
            }
            // 点气泡后，客户端来问「要打开哪条记录」；取走即清空，避免重复弹出。
            if (rest === 'buddy/pending' && req.method === 'GET') {
              send(200, {
                ok: true,
                recordId: pendingOpen?.recordId ?? '',
                panel: pendingOpen?.panel === true,
                at: pendingOpen?.at ?? 0,
              });
              return;
            }
            if (rest === 'buddy/consume' && req.method === 'POST') {
              const taken = pendingOpen;
              pendingOpen = null;
              send(200, { ok: true, recordId: taken?.recordId ?? '', at: taken?.at ?? 0 });
              return;
            }
            if (rest === 'history' && req.method === 'GET') {
              const q = url.searchParams;
              const from = q.get('from') ?? '';
              const to = q.get('to') ?? '';
              const rangeBytes = history.rangeBytes({ from, to });
              send(200, {
                ok: true,
                rangeBytes,
                rangeSize: history.formatBytes(rangeBytes),
                ...history.list({
                  q: q.get('q') ?? '',
                  from,
                  to,
                  app: q.get('app') ?? '',
                  mode: q.get('mode') ?? '',
                  limit: q.get('limit') ?? 200,
                }),
                stats: history.stats(),
                diskBytes: history.diskUsage(),
              });
              return;
            }
            if (rest === 'history/chat' && req.method === 'POST') {
              let body = {};
              try {
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
              } catch {
                send(400, { ok: false, error: 'bad-json' });
                return;
              }
              const record = history.get(String(body.id ?? ''));
              const question = String(body.question ?? '').trim();
              if (!record) {
                send(404, { ok: false, reason: '记录不存在（可能已被清理）' });
                return;
              }
              if (question === '') {
                send(400, { ok: false, reason: '问题不能为空' });
                return;
              }
              const result = await askAbout({ ctx, config, record, question, logger });
              if (!result.ok) {
                send(200, { ok: false, reason: result.reason });
                return;
              }
              const now = new Date().toISOString();
              const thread = [
                ...(Array.isArray(record.thread) ? record.thread : []),
                { role: 'user', text: question, at: now },
                { role: 'assistant', text: result.answer, at: now, usage: result.usage ?? null },
              ];
              const updated = history.update(record.id, { thread });
              send(200, { ok: true, answer: result.answer, usage: result.usage, thread: updated?.thread ?? thread });
              return;
            }
            if (rest === 'presets' && req.method === 'GET') {
              try {
                const presets = (await ctx.get('agentPresets')?.list?.()) ?? [];
                const items = presets.map((p) => ({
                  id: String(p.id ?? ''),
                  name: String(p.name ?? p.title ?? p.id ?? ''),
                  description: String(p.description ?? '').slice(0, 120),
                }));
                send(200, { ok: true, items });
              } catch (error) {
                send(200, { ok: false, items: [], reason: String(error?.message ?? error) });
              }
              return;
            }
            if (rest === 'workspaces' && req.method === 'GET') {
              try {
                const registry = ctx.get('workspaceRegistry');
                const items = (registry?.list?.() ?? []).map((w) => ({ id: w.id, title: w.title, path: w.path }));
                send(200, { ok: true, items });
              } catch (error) {
                send(200, { ok: false, items: [], reason: String(error?.message ?? error) });
              }
              return;
            }
            // 临时实验：把本插件创建的会话从工作区摘除/挂回（文件保留）。
            if (rest === 'spike/workspace-toggle' && req.method === 'GET') {
              try {
                const action = url.searchParams.get('action') === 'attach' ? 'attach' : 'detach';
                const registry = ctx.get('workspaceRegistry');
                const ws = registry?.list?.()[0];
                if (!ws) {
                  send(200, { ok: false, reason: '没有工作区' });
                  return;
                }
                const ids = [...ws.sessionIds].filter((id) => /^(companion|spike)-/.test(String(id)));
                for (const id of ids) {
                  if (action === 'detach') await ws.detachSession?.(id);
                  else await ws.attachSession?.(id);
                }
                send(200, { ok: true, action, count: ids.length, ids });
              } catch (error) {
                send(200, { ok: false, reason: String(error?.message ?? error) });
              }
              return;
            }
            if (rest === 'history/spawn' && req.method === 'POST') {
              let body = {};
              try {
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
              } catch {
                send(400, { ok: false, error: 'bad-json' });
                return;
              }
              const record = history.get(String(body.id ?? ''));
              if (!record) {
                send(404, { ok: false, reason: '记录不存在（可能已被清理）' });
                return;
              }
              const agents = ctx.get('agents');
              if (!agents?.create) {
                send(200, { ok: false, reason: '宿主没有 agents 服务，无法创建会话' });
                return;
              }

              // 目标工作区：优先用面板传来的 cwd，否则退到注册表里的第一个。
              const registry = ctx.get('workspaceRegistry');
              let cwd = String(body.cwd ?? '');
              if (cwd === '') {
                try {
                  cwd = String(registry?.list?.()[0]?.path ?? process.cwd());
                } catch {
                  cwd = process.cwd();
                }
              }

              // 种子里放**原图**（用户明确要带大图）；没有原图才退回缩略图。
              // 多画面记录按 images[] 顺序最多带 9 张：新会话里模型看不到别的图，
              // 少带一张，它就少一份证据。
              const imageBlocks = [];
              try {
                const attachments = ctx.get('attachments');
                const { readFile } = await import('node:fs/promises');
                const { dirname, join } = await import('node:path');
                const base = dirname(config.history.path.replace(/^~/, process.env.HOME ?? ''));
                // 统一取图：看一阵的每段拼图、多画面的每张、单画面的一张——都走 recordImagePaths，
                // 否则「看一阵」的记录开新会话只会带上第一张拼图（用户实测报过）。
                const sources = recordImagePaths(record, 9);
                for (const rel of sources) {
                  const bytes = await readFile(join(base, rel));
                  const mediaType = /\.jpe?g$/i.test(rel) ? 'image/jpeg' : /\.webp$/i.test(rel) ? 'image/webp' : 'image/png';
                  const refs = await attachments.saveImages([
                    { data: new Uint8Array(bytes), mediaType, name: `capture-${imageBlocks.length}.${rel.split('.').pop()}` },
                  ]);
                  const ref = Array.isArray(refs) ? refs[0] : refs;
                  if (ref) imageBlocks.push({ type: 'image', attachment: ref });
                }
              } catch (error) {
                logger.warn?.(`[dsh-companion-journal] 开新会话时附图失败，退化为纯文字：${reasonOf(error)}`);
              }

              const sessionId = `companion-${Date.now().toString(36)}`;
              const preset = String(body.agentPreset || config?.spawn?.agentPreset || 'standard');
              const { seed, message } = buildSessionSeed({
                text: describeRecord(record, { attached: imageBlocks.length }),
                images: imageBlocks,
                title: `讨论：${record.app || '窗口'}${record.title ? `「${record.title.slice(0, 20)}」` : ''}`,
                agentPreset: preset,
              });
              // 必须显式给模型路由：不带的话 agent 起不了 turn
              // （实测报错 "agent has no provider/model"）。
              const selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? {};
              let handle;
              try {
                handle = await agents.create({
                  sessionId,
                  seed,
                  meta: { cwd, isSeeded: true, agentPreset: preset },
                  inheritedEventCount: 0,
                  agentOptions: {
                    ...(selection.provider ? { provider: selection.provider } : {}),
                    ...(selection.model ? { model: selection.model } : {}),
                    ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
                  },
                });
              } catch (error) {
                send(200, { ok: false, reason: `创建会话失败：${String(error?.message ?? error)}` });
                return;
              }

              // 关键一步：用 followup 注入首条消息并唤醒一轮。
              // 只有跑过一轮，会话投影的 blank 才会变 false，侧边栏才显示。
              let turnStarted = false;
              try {
                if (typeof handle?.agent?.followup === 'function') {
                  handle.agent.followup(message);
                  turnStarted = true;
                  spawnedAgents.add(handle);
                  let released = false;
                  const release = () => {
                    if (released) return;
                    released = true;
                    releaseSpawned(handle);
                  };
                  // 一轮结束（status 回到 idle）就释放；拿不到事件就退化成定时释放。
                  try {
                    handle.agent?.dispatch?.on?.('agent/status', (payload) => {
                      if (payload?.status === 'idle') release();
                    });
                  } catch {
                    /* 没有 dispatch 就用定时器 */
                  }
                  const timer = setTimeout(release, 300000);
                  timer?.unref?.();
                }
              } catch (error) {
                logger.warn?.(`[dsh-companion-journal] 首轮没能启动：${reasonOf(error)}`);
              }

              let workspace = null;
              try {
                const ws = await registry?.resolveByPath?.(cwd);
                if (ws?.attachSession) {
                  await ws.attachSession(sessionId);
                  workspace = { id: ws.id, title: ws.title };
                }
              } catch (error) {
                logger.warn?.(`[dsh-companion-journal] 会话没挂进工作区：${reasonOf(error)}`);
              }

              send(200, {
                ok: true,
                sessionId,
                cwd,
                workspace,
                withImage: imageBlocks.length > 0,
                imageCount: imageBlocks.length,
                turnStarted,
              });
              return;
            }
            if (rest === 'history/delete' && req.method === 'POST') {
              let body = {};
              try {
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
              } catch {
                send(400, { ok: false, error: 'bad-json' });
                return;
              }
              const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string') : [];
              if (ids.length === 0) {
                send(400, { ok: false, reason: '没有指定要删除的记录' });
                return;
              }
              send(200, history.deleteRecords(ids));
              return;
            }
            if (rest === 'history/cleanup' && req.method === 'POST') {
              let body = {};
              try {
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
              } catch {
                send(400, { ok: false, error: 'bad-json' });
                return;
              }
              const result = history.cleanup({
                from: String(body.from ?? ''),
                to: String(body.to ?? ''),
                mode: body.mode === 'images' ? 'images' : 'all',
              });
              send(result.ok ? 200 : 400, result);
              return;
            }
            send(404, { ok: false, error: 'not-found' });
          } catch (error) {
            send(500, { ok: false, error: 'internal', message: String(error?.message ?? error) });
          }
        },
      });
      return () => {
        try {
          dispose?.();
        } catch {
          /* 忽略 */
        }
      };
    } catch (error) {
      logger.warn?.(`[dsh-companion-journal] 状态接口注册失败：${reasonOf(error)}`);
      return () => {};
    }
  });

  /**
   * 跑一次「看一眼」：读选中 → 调模型 → 让桌宠说 → 写记录。
   *
   * 热键（F8）、桌宠左键、面板观察都走这一条，保证行为一致；
   * `askQuestion` 有值时就变成 F7（先问一句）。
   */
  async function runLook({ mode = 'f8', desktopScreen = null } = {}) {
    const startedAt = Date.now();
    hotkey.presses += 1;

    // 收集模式：F8 = 只截一张加进集合（不调模型）；F7 = 就这一组提问并结束。
    if (collection.active()) {
      const frontSnapshot = await frontApp(ctx).catch(() => null);
      if (mode === 'f7') {
        const viaBuddy = await askViaBuddy(buddyPaths(), '想问这一组什么？').catch(() => ({ ok: false }));
        const answer = viaBuddy.ok ? viaBuddy : await askQuestionViaScript(ctx);
        if (!answer.ok || answer.cancelled) return { ok: false, stage: 'cancelled' };
        return finishCollection(ctx, { question: String(answer.text ?? '').trim() });
      }
      const shot = await captureForCollect({ ctx, history, frontSnapshot, ocrNow: false, desktopScreen });
      if (!shot.ok) {
        void say(ctx, `这张没截到：${String(shot.error ?? '').slice(0, 40)}`, { compact: true }).catch(() => {});
        return shot;
      }
      const count = collection.add(shot);
      await showCollectBubble(ctx, count);
      return { ok: true, via: 'collect', count };
    }

    // 先拍下「按下那一刻的前台」再做任何 UI：气泡/面板一出现就可能改变前台，
    // 之后再去问 frontApp 会拿到我们自己的窗口或上一个应用（实测踩过）。
    // 约束与自检清单见 DEVLOG 第 7.5 节「目标判定一类的设计约束」——改这段前先读它。
    const frontSnapshot = await frontApp(ctx).catch(() => null);
    // 立刻给个反应：模型那一步要几秒，没有这个「已收到」用户就以为没按上。
    // 顺带报出「正在看哪个窗口」——和看一阵的气泡一致，用户能确认没看错对象。
    void say(ctx, `看一眼 · ${targetLabel(frontSnapshot)}`, { compact: true, bold: true }).catch(() => {});
    try {
      const selected = await selectionText(ctx);
      lastSelection = {
        axTrusted: selected?.axTrusted ?? null,
        app: String(selected?.app ?? ''),
        // 桥给的判定来源：range / clipboard / 空。sawCaret 表示「明确是光标」。
        source: String(selected?.source ?? ''),
        sawRange: selected?.sawRange ?? null,
        sawCaret: selected?.sawCaret ?? null,
        textHead: String(selected?.text ?? '').slice(0, 30),
        chars: String(selected?.text ?? '').length,
        at: Date.now(),
      };
      if (selected?.axTrusted === false) {
        logger.warn?.('[dsh-companion-journal] 没开辅助功能：选中文字读不到，只能看窗口');
      }
      const text = selected?.axTrusted === false ? '' : String(selected?.text ?? '');
      // 超时保护：模型调用没有超时的话，一次卡住会让 busy 永久为真，
      // 之后所有触发都静默失效（实测症状：触发一次就再也点不动）。
      // F7：抓取之后先问一句。取消返回 null（整条链路作废）；
      // 直接回车返回空串（按 F8 处理，不打断）。
      const asker =
        mode === 'f7'
          ? async () => {
              const viaBuddy = await askViaBuddy(buddyPaths(), '问点什么？').catch(() => ({ ok: false }));
              const answer = viaBuddy.ok ? viaBuddy : await askQuestionViaScript(ctx);
              if (!answer.ok) {
                logger?.warn?.(`[dsh-companion-journal] 提问框没起来：${answer.reason}`);
                return null;
              }
              return answer.cancelled ? null : answer.text;
            }
          : null;
      const outcome = await Promise.race([
        lookOnce({
          ctx,
          config,
          logger,
          selectedText: text,
          selectedApp: String(selected?.app ?? ''),
          history,
          mode,
          askQuestion: asker,
          frontSnapshot,
          desktopScreen,
        }),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ ok: false, stage: 'timeout', error: '看一眼超时（90s）' }), 90000);
          timer?.unref?.();
        }),
      ]);
      menu.lastOutcome = outcome.ok ? 'ok' : String(outcome.stage ?? 'unknown');
      menu.lastError = outcome.ok ? null : String(outcome.error ?? '');
      if (typeof outcome.ms === 'number') hotkey.lastMs = outcome.ms;
      // 取消（F7 按了 Esc）是正常操作，不该被当成失败说出来。
      if (!outcome.ok && outcome.stage !== 'cancelled') {
        await say(ctx, `看一眼没成：${String(outcome.error ?? '').slice(0, 60)}`);
      }
      return outcome;
    } catch (error) {
      logger.warn?.(`[dsh-companion-journal] 看一眼失败：${reasonOf(error)}`);
      return { ok: false, stage: 'exception', error: String(error?.message ?? error) };
    } finally {
      hotkey.lastMs = Date.now() - startedAt;
    }
  }

  // ── 全局热键：有选中读选中，没选中看窗口 ─────────────────────────────────
  // 注册有两条路：优先 Electron globalShortcut（零新进程）；宿主只是普通 Node 进程时
  // 拿不到它，就退回桥的常驻监听（几 MB、空闲 0 CPU、事件写文件 + fs.watch）。
  ctx.effect(() => {
    if (!config.hotkey.enabled) return () => {};
    // 浮窗启用时，热键由浮窗进程（Carbon）注册——这条老链路只在没有浮窗时才需要，
    // 否则会多挂一个常驻桥进程做同一件事。
    if (config.buddy.enabled === true) return () => {};
    let dispose = null;
    let stopped = false;
    let busy = false;
    /** 忙的时候最多记一次：一次「看一眼」要几秒，连按不该丢光，也不该排队堆成雪崩。 */
    let queued = false;

    const onPress = () => {
      if (stopped) return;
      if (busy) {
        hotkey.dropped += 1;
        queued = true;
        return;
      }
      busy = true;
      hotkey.busy = true;
      void (async () => {
        try {
          await runLook({ mode: 'f8' });
        } finally {
          busy = false;
          hotkey.busy = false;
          if (queued && !stopped) {
            queued = false;
            onPress();
          }
        }
      })();
    };

    void (async () => {
      const electron = await registerHotkey(config.hotkey.spec, onPress);
      if (stopped) {
        electron.dispose?.();
        return;
      }
      if (electron.ok) {
        dispose = electron.dispose;
        hotkey.registered = true;
        hotkey.accelerator = electron.accelerator;
        hotkey.backend = 'electron';
        logger.info?.(`[dsh-companion-journal] 已注册热键 ${electron.accelerator}（Electron）`);
        return;
      }

      logger.info?.(`[dsh-companion-journal] Electron 热键不可用（${electron.reason}），改用桥的常驻监听`);
      const bridge = await startBridgeHotkey(ctx, {
        spec: config.hotkey.spec,
        binPath: bridgePath,
        // 固定路径：macOS 快捷指令会往这里追加一行，路径不能随进程变。
        eventsFile: hotkeyEventsPath(),
        onPress,
        logger,
        spawn: config.hotkey.mode !== 'shortcut',
      });
      if (stopped) {
        bridge.dispose?.();
        return;
      }
      if (bridge.ok) {
        dispose = bridge.dispose;
        hotkey.registered = true;
        hotkey.accelerator = config.hotkey.spec;
        hotkey.backend = config.hotkey.mode === 'shortcut' ? 'shortcut' : 'bridge';
        hotkey.error = null;
        logger.info?.(`[dsh-companion-journal] 已注册热键 ${config.hotkey.spec}（桥常驻监听）`);
      } else {
        hotkey.error = String(bridge.reason ?? '注册失败');
        logger.warn?.(`[dsh-companion-journal] 热键未注册：${hotkey.error}`);
      }
    })();

    return () => {
      stopped = true;
      try {
        dispose?.();
      } catch {
        /* 忽略 */
      }
    };
  });

  // ── 桌宠浮窗：自绘静态立绘 + 气泡 + 右键菜单 ─────────────────────────────
  // 为什么不挂在 DSH 窗口里：要「我在 Word 里时它也在」就必须是独立进程。
  // 浮窗崩了自动重启，且它不可用时 F8/F7 照常完成（记录照写），只是没气泡。
  ctx.effect(() => {
    // 测试环境不拉真进程：它会常驻，让 `node test/*.js` 永远退不出去。
    if (process.env.DSH_COMPANION_NO_BUDDY === '1') return () => {};
    // 非 macOS 上包内是 Mach-O，拉起来只会进入无意义的退避循环。
    if (process.platform !== 'darwin') return () => {};
    restartBuddy();
    return () => {
      setSurface(null);
      try {
        buddyHandle?.dispose?.();
      } catch {
        /* 忽略 */
      }
      buddyHandle = null;
    };
  });

  // ── 旁观器 ──────────────────────────────────────────────────────────────
  ctx.effect(() => {
    if (config.observe.enabled) observer.schedule();
    return () => observer.stop();
  });

  logger.info?.(
    `[dsh-companion-journal] 已加载：旁观默认${config.observe.enabled ? '开启' : '关闭'}，` +
      `间隔 ${config.observe.intervalMs}ms，桌宠${buddyState.running ? '在线' : '未启动'}`,
  );
}
