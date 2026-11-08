/**
 * 旁观器：前台窗口一换，就让桌宠说一句。
 *
 * 三条自律（不做就会变成骚扰）：
 *   1. **采样，不录屏。** 一个 tick 只读前台应用 + 窗口标题 + 空闲秒数。
 *   2. **说的话不描述窗口。** 台词来自固定短句池且不打乱顺序 —— 「从 Word 切到
 *      Safari」对用户零信息量，他要的是「有个东西注意到我换了」。
 *   3. **DSH 自己的窗口是透明的。** 你切过来看聊天不算换场景，不然每看一眼都要挨一句。
 *
 * @module dsh-companion-journal/lib/observer
 */

import { frontApp } from './native.js';
import { say } from './surface.js';
import {
  RateLimiter,
  decideVisibility,
  isHostApp,
  narrateLastSeen,
  pickSwitchLine,
  sceneSignature,
} from './policy.js';

export function createObserver({ ctx, config, logger }) {
  const limiter = new RateLimiter({
    minGapSec: config.observe.minGapSec,
    maxPerHour: config.observe.maxPerHour,
  });

  let enabled = Boolean(config.observe.enabled);
  let timer = null;
  let ticking = false;
  let lastSignature = null;
  let lastScene = null;
  /** 最近一次「不是 DSH 自己」的场景：HUD 的「看一眼」与胶囊文案都用它。 */
  let lastActivity = null;
  /** 被限频压住、还没说出去的那一句（等额度回来自动补说）。 */
  let pending = null;
  let lastSaid = null;
  let lastSkip = null;
  let ticks = 0;

  function log(level, message) {
    try {
      logger?.[level]?.(`[dsh-companion-journal] ${message}`);
    } catch {
      /* 日志不该影响主流程 */
    }
  }

  /** 真正投给桌宠；成功才记额度。 */
  async function speak(line) {
    const spoken = await say(ctx, line);
    if (!spoken.ok) {
      lastSkip = { reason: `buddy-${spoken.reason}`, detail: spoken.message ?? null, at: Date.now() };
      return { skipped: `buddy-${spoken.reason}` };
    }
    limiter.record();
    lastSaid = { text: line, at: Date.now() };
    lastSkip = null;
    return { said: line };
  }

  /** 单次采样。返回这一拍的判断结果，供 /state 与命令展示。 */
  async function tick({ force = false } = {}) {
    if (ticking) return { skipped: 'busy' };
    ticking = true;
    ticks += 1;
    try {
      const front = await frontApp(ctx);
      const scene = {
        appName: front.name ?? '',
        bundleId: front.bundleId ?? '',
        windowTitle: front.windowTitle ?? '',
        idleSeconds: front.idleSeconds ?? 0,
        at: Date.now(),
      };
      lastScene = scene;

      const self = isHostApp(scene);
      const signature = sceneSignature({
        app: scene.appName,
        title: scene.windowTitle,
        idle: scene.idleSeconds,
      });
      const first = lastSignature === null;
      const unchanged = signature === lastSignature;
      lastSignature = signature;

      // 「看一眼」：用户主动要一次反应。热键在 DSH 窗口里按下时前台是 DSH 自己，
      // 重新采样只会看到自己 —— 所以报最近一次「别处」的采样。
      if (force) {
        if (!self) lastActivity = { appName: scene.appName, windowTitle: scene.windowTitle, at: Date.now() };
        return speak(narrateLastSeen(lastActivity));
      }

      // 自己的窗口是透明的：不更新类别、不更新 lastActivity。
      if (self) return { skipped: 'self-window', activity: lastActivity?.appName ?? null };

      if (unchanged && !pending) return { skipped: 'unchanged' };

      lastActivity = { appName: scene.appName, windowTitle: scene.windowTitle, at: Date.now() };

      // 第一拍只记基线，不开口：否则刚打开旁观就白占一次额度。
      if (first) return { skipped: 'baseline' };

      // 待播优先（上一拍被限频压住的那句），否则挑一句新的、且不与上一句重复。
      let line = pending ? pending.line : pickSwitchLine(lastSaid?.text);
      pending = null;

      const verdict = decideVisibility({
        appName: scene.appName,
        windowTitle: scene.windowTitle,
        config,
        rateLimiter: limiter,
      });
      if (!verdict.ok) {
        // 只对「额度还没回来」保留待播：黑名单、静默时段、敏感标题都不该排队
        // —— 等它们放行时那句话早就过时了。
        if (verdict.reason === 'rate-limited') pending = { line };
        lastSkip = { reason: verdict.reason, detail: verdict.detail, at: Date.now() };
        return { skipped: verdict.reason, detail: verdict.detail };
      }

      return await speak(line);
    } catch (error) {
      // 采样失败（桥没编译、权限没给）不该刷屏：记最后一次原因即可。
      lastSkip = { reason: 'tick-failed', detail: String(error?.message ?? error), at: Date.now() };
      log('warn', `旁观采样失败：${String(error?.message ?? error)}`);
      return { skipped: 'tick-failed' };
    } finally {
      ticking = false;
    }
  }

  function schedule() {
    // 关着就别建定时器：一个「永远 return 的空转 interval」也是持续唤醒。
    if (!enabled) return;
    if (timer) return;
    const interval = Math.max(5000, Number(config.observe.intervalMs) || 10000);
    timer = setInterval(() => {
      if (!enabled) return;
      void tick();
    }, interval);
    // 定时器不该把进程钉住（测试与卸载时尤其明显）。
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function status() {
    return {
      enabled,
      ticks,
      lastScene,
      lastActivity,
      self: lastScene ? isHostApp(lastScene) : false,
      pending: pending ? { line: pending.line } : null,
      lastSaid,
      lastSkip,
      rate: limiter.snapshot(),
      intervalMs: config.observe.intervalMs,
    };
  }

  function setEnabled(next) {
    enabled = Boolean(next);
    if (enabled) schedule();
    log('info', enabled ? '旁观已开启' : '旁观已暂停');
    return enabled;
  }

  return { tick, start: () => setEnabled(true), pause: () => setEnabled(false), setEnabled, status, stop, schedule };
}
