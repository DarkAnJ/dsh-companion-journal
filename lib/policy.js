/**
 * 纯策略层：不碰系统、不碰网络、不碰 ctx。
 *
 * 单独拆出来是因为这些规则最容易写错，而它们又是唯一可以用单元测试兜住的部分：
 * 窗口黑名单匹配、静默时段、限频、脱敏、场景签名。宿主侧出问题时，先怀疑的是
 * 系统桥，不是这里；把规则隔离出来，排障范围就小一半。
 *
 * @module dsh-companion-journal/lib/policy
 */

/** 把 "23:00-08:00" 解析成可比较的分钟区间，支持跨零点。 */
export function parseQuietRange(range) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(range ?? ''));
  if (!m) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start === end) return null;
  return { start, end };
}

/** 当前分钟是否落在静默时段内（跨零点时按两段判断）。 */
export function inQuietHours(date, ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  for (const raw of ranges) {
    const r = parseQuietRange(raw);
    if (!r) continue;
    if (r.start < r.end) {
      if (minutes >= r.start && minutes < r.end) return true;
    } else if (minutes >= r.start || minutes < r.end) {
      // 例如 23:00-08:00：要么已过 23:00，要么还没到 08:00。
      return true;
    }
  }
  return false;
}

function normalizePatterns(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => typeof x === 'string' && x.trim() !== '')
    .map((x) => x.trim().toLowerCase());
}

/** 名字是否命中黑名单（子串匹配，大小写不敏感）。 */
export function matchesAny(value, patterns) {
  const text = String(value ?? '').toLowerCase();
  if (!text) return false;
  return normalizePatterns(patterns).some((p) => text.includes(p));
}

/**
 * 决定「现在能不能看」。
 * 返回值带 reason，是为了让上层能给出可操作的话（「检测到密码管理器，先不看了」），
 * 而不是静默什么都不做 —— 静默失败会让人以为插件坏了。
 */
export function decideVisibility({ appName, windowTitle, config, now = new Date(), rateLimiter }) {
  const observe = config?.observe ?? {};
  if (matchesAny(appName, observe.denyApps)) {
    return { ok: false, reason: 'deny-app', detail: `应用在排除名单：${appName}` };
  }
  if (config?.privacy?.pauseOnSensitiveTitles !== false && matchesAny(windowTitle, observe.denyTitlePatterns)) {
    return { ok: false, reason: 'sensitive-title', detail: '窗口标题命中敏感词' };
  }
  if (inQuietHours(now, observe.quietHours)) {
    return { ok: false, reason: 'quiet-hours', detail: '处于静默时段' };
  }
  if (rateLimiter && !rateLimiter.canEmit(now.getTime())) {
    return { ok: false, reason: 'rate-limited', detail: '达到本次频率上限' };
  }
  return { ok: true, reason: null, detail: null };
}

/**
 * 滑动窗口限频：既限「每小时总数」，也限「两次之间至少隔多久」。
 *
 * 两个闸都要：只有小时上限时，前十分钟可以把额度耗光然后连发；只有间隔时，
 * 一整天累积下来会很吵。宁可两把锁，也不要一个能调错的旋钮。
 */
export class RateLimiter {
  #timestamps = [];
  #minGapMs;
  #maxPerHour;

  constructor({ minGapSec = 300, maxPerHour = 6 } = {}) {
    this.#minGapMs = Math.max(0, Number(minGapSec) || 0) * 1000;
    this.#maxPerHour = Math.max(1, Number(maxPerHour) || 1);
  }

  #prune(nowMs) {
    const cutoff = nowMs - 3600_000;
    this.#timestamps = this.#timestamps.filter((t) => t > cutoff);
  }

  /** 现在能不能说一句。 */
  canEmit(nowMs = Date.now()) {
    this.#prune(nowMs);
    if (this.#timestamps.length >= this.#maxPerHour) return false;
    const last = this.#timestamps[this.#timestamps.length - 1];
    if (last !== undefined && nowMs - last < this.#minGapMs) return false;
    return true;
  }

  /** 记一次实际发生。 */
  record(nowMs = Date.now()) {
    this.#prune(nowMs);
    this.#timestamps.push(nowMs);
  }

  /** 供 /state 展示剩余额度。 */
  snapshot(nowMs = Date.now()) {
    this.#prune(nowMs);
    return {
      usedLastHour: this.#timestamps.length,
      maxPerHour: this.#maxPerHour,
      minGapSec: Math.round(this.#minGapMs / 1000),
      nextAllowedAt: this.canEmit(nowMs)
        ? nowMs
        : Math.max(
            (this.#timestamps[0] ?? nowMs) + 3600_000,
            (this.#timestamps[this.#timestamps.length - 1] ?? nowMs) + this.#minGapMs,
          ),
    };
  }
}

/** 场景签名：只要这三样没变，就不算「换了件事」，不必重新判断。 */
export function sceneSignature({ app = '', title = '', idle = 0 }) {
  // 空闲跨过 60s 的整数倍时才变，否则每 10s 都算一次新场景，等于没去重。
  const idleBucket = Math.floor(Number(idle) / 60);
  return `${app}\u0000${title}\u0000${idleBucket}`;
}

/** 按配置对文本做脱敏；命中即替换成占位，不保留长度信息。 */
export function redact(text, patterns) {
  const source = String(text ?? '');
  const list = normalizePatterns(patterns);
  if (list.length === 0) return source;
  let out = source;
  for (const p of list) {
    // 用 split/join 而不是正则：用户填的词可能含正则元字符（比如 "C++"）。
    out = out.split(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join('[已脱敏]');
  }
  return out;
}

/** 把窗口信息压成一句人能读的话，用于桌宠旁白（不调模型）。 */
export function narrateScene({ appName, windowTitle, idleSeconds }) {
  const app = String(appName ?? '').trim();
  if (!app) return '';
  const idle = Number(idleSeconds) || 0;
  const where = windowTitle ? `${app}「${windowTitle}」` : app;
  if (idle >= 600) return `你已经很久没动了（${Math.round(idle / 60)} 分钟），${where} 还开着。`;
  if (idle >= 120) return `你在 ${where} 前面停了一会儿。`;
  return `你在看 ${where}。`;
}

/**
 * 活动类别：只用来决定「这个时刻值不值得插一句话」，不参与隐私判断。
 *
 * 分类顺序是有意的：先看**应用名**（强信号，够了就别猜），应用名不认识才看
 * **窗口标题**（浏览器是「什么都能开」的容器，只能靠标题分）。宁可归到 other
 * 少说一句，也不要把「在 GitHub 看代码」说成「在玩」。
 */
const APP_CATEGORY_RULES = [
  // 读书类先于社交：微信读书带着「微信」两个字，但它是看书，不是聊天。
  { re: /微信读书|kindle|books|图书/i, category: 'fun' },
  {
    re: /word|pages|numbers|excel|powerpoint|keynote|zotero|marginnote|obsidian|notion|tex|overleaf|skim|acrobat|preview|记账/i,
    category: 'work',
  },
  { re: /xcode|studio ?code|vscode|cursor|intellij|webstorm|pycharm|terminal|iterm|warp|figma|sublime/i, category: 'work' },
  { re: /bilibili|哔哩|youtube|netflix|爱奇艺|优酷|腾讯视频|抖音|tiktok|twitch|spotify|music|音乐|iina|vlc|steam/i, category: 'fun' },
  { re: /wechat|微信|qq|飞书|lark|dingtalk|钉钉|slack|discord|telegram|邮件|mail|messages|短信/i, category: 'social' },
];

/** 浏览器 / 阅读器这类容器，用标题判。 */
const TITLE_CATEGORY_RULES = [
  { re: /bilibili|哔哩|youtube|netflix|爱奇艺|腾讯视频|优酷|抖音|tiktok|微博|小红书|知乎|twitch|steam/i, category: 'fun' },
  {
    re: /github|gitlab|stack ?overflow|developer\.mozilla|docs\.|arxiv|scholar\.google|jira|confluence|overleaf|figma|\.pdf\b/i,
    category: 'work',
  },
  { re: /wechat|微信网页|web\.wechat|飞书|lark|slack|discord|telegram|outlook|gmail|邮箱/i, category: 'social' },
];

/**
 * 推断当前场景属于哪类活动：`work` / `fun` / `social` / `other`。
 * @returns {'work'|'fun'|'social'|'other'}
 */
export function sceneCategory({ appName, windowTitle } = {}) {
  const app = String(appName ?? '');
  const title = String(windowTitle ?? '');
  for (const rule of APP_CATEGORY_RULES) {
    if (rule.re.test(app)) return rule.category;
  }
  for (const rule of TITLE_CATEGORY_RULES) {
    if (rule.re.test(title)) return rule.category;
  }
  return 'other';
}

/**
 * 跨类别切换时的那一句（同一类别内的窗口变化不出声）。
 *
 * 只在类别真的变了时才给台词：在同一类里换个文件、换一个网页就开口，
 * 会变成骚扰；而「从办公切到娱乐」正是最值得说一句的时刻。
 *
 * @param {object} args
 * @param {'work'|'fun'|'social'|'other'} args.category 现在的类别
 * @param {{category:string, appName:string}|null} args.previous 上一拍的类别与来源
 * @param {{appName:string, windowTitle:string}} args.scene 现在的场景
 * @returns {string} 空串 = 这一拍不该说话
 */
export function narrateTransition({ category, previous, scene } = {}) {
  const app = String(scene?.appName ?? '').trim() || '那边';
  const from = String(previous?.category ?? '');
  if (from === category) return '';
  // 只对「已知类别之间的切换」开口：从 DSH 窗口、Finder 这类 other 切过去时
  // 说「又开工了」纯属噪音 —— 你本来就没离开工作。
  if (from === 'other') return '';
  const fromApp = String(previous?.appName ?? '').trim();

  if (category === 'fun') {
    return fromApp ? `从 ${fromApp} 切到 ${app} 了，歇一会儿吧。` : `到 ${app} 放松一下？`;
  }
  if (category === 'work') {
    return fromApp ? `回到 ${app} 了，刚才在 ${fromApp}。` : `在 ${app} 忙起来了。`;
  }
  if (category === 'social') {
    return fromApp ? `切到 ${app} 聊天？` : `在 ${app} 聊天。`;
  }
  return '';
}

/**
 * 窗口一换就说一句的台词池。
 *
 * 刻意**不描述窗口内容**：「从 Word 切到 Safari」这种话对用户零信息量，
 * 他能看见自己切了什么。桌宠该提供的是「有个东西注意到你了」的存在感，
 * 所以这里全是短句，且不含任何应用名、文档名 —— 也就不存在从标题泄露隐私的问题。
 */
export const SWITCH_LINES = [
  '又换啦？',
  '我跟过来了。',
  '这个我也在看着。',
  '嗯，你忙你的。',
  '换地方也不说一声。',
  '我在这儿呢。',
  '看得这么专注呀。',
  '要不要我陪你盯一会儿？',
  '你跳得真快。',
  '刚才那个不看了？',
  '我记下了。',
  '先不吵你，需要就叫我。',
];

/**
 * 随机挑一句，且不会和上一句重复（重复最容易让人觉得「它根本没在看」）。
 * @param {string|undefined} previous 上一句说过的话
 * @param {() => number} [random] 注入随机源，测试用
 */
export function pickSwitchLine(previous, random = Math.random) {
  const pool = SWITCH_LINES.filter((line) => line !== previous);
  const list = pool.length > 0 ? pool : SWITCH_LINES;
  const index = Math.min(list.length - 1, Math.max(0, Math.floor(random() * list.length)));
  return list[index];
}

/**
 * 从窗口列表里挑「你刚才在用的那个窗口」。
 *
 * CGWindowList 是**前到后**排序的，所以 DSH 之下的第一个正常窗口就是最近在用的那个。
 * 这样「不管在哪里点看一眼，都去看我刚在写的 Word」不需要任何后台跟踪 ——
 * 点的时候现查一次即可，也不改变插件对「前台窗口」的定义。
 *
 * @param {object[]} windows 桥返回的窗口列表（前到后）
 * @param {{ host?: (w: object) => boolean }} [options]
 */
export function pickRecentWindow(windows, { host = isHostApp } = {}) {
  const list = Array.isArray(windows) ? windows : [];
  for (const win of list) {
    if (!win || win.onScreen === false) continue;
    if (Number(win.layer ?? 0) !== 0) continue;
    if (host({ bundleId: win.bundleId, appName: win.ownerName })) continue;
    const bounds = win.bounds ?? {};
    // 太小的多半是工具浮窗、贴纸、输入法候选框，看一眼它们没有意义。
    if (Number(bounds.w) * Number(bounds.h) < 200 * 200) continue;
    return {
      windowId: Number(win.windowId ?? 0),
      appName: String(win.ownerName ?? ''),
      bundleId: String(win.bundleId ?? ''),
      pid: Number(win.ownerPid ?? 0),
      windowTitle: String(win.title ?? ''),
    };
  }
  return null;
}

/**
 * 是不是「我们自己的窗口」。
 *
 * DSH 的界面不是「你在干什么」——它是你来看结果的地方。把它算进活动里会有两个后果：
 * 类别被冲成 other（切回来时被判成「没换类型」），以及「看一眼」永远
 * 只报出 DSH 自己。所以它必须是透明的。
 */
// 我们自己也算「宿主」：点桌宠若把焦点抢过来，看一眼不该去看桌宠自己。
const HOST_HINTS = { bundleId: 'com.deepseek.dsh', name: /deepseek harness|dsh-buddy/i };

export function isHostApp({ bundleId, appName } = {}) {
  const id = String(bundleId ?? '').toLowerCase();
  const name = String(appName ?? '');
  return id === HOST_HINTS.bundleId || HOST_HINTS.name.test(name);
}

/**
 * 「它最后看到你在别处做什么」——「看一眼」在 DSH 前台时用它，而不是重新采样一次。
 *
 * 热键在 DSH 窗口里按下时前台必然是 DSH，重新采样只会得到自己；回看最近一次
 * 非 DSH 的采样才有信息量。
 */
export function narrateLastSeen(activity, now = Date.now()) {
  const app = String(activity?.appName ?? '').trim();
  if (!app) return '我还没看到你在别的地方做什么。';
  const title = String(activity?.windowTitle ?? '').trim();
  const shortTitle = title.length > 40 ? `${title.slice(0, 40)}…` : title;
  const seconds = Math.max(0, Math.round((now - Number(activity?.at ?? now)) / 1000));
  const ago = seconds < 60 ? `${seconds} 秒前` : `${Math.round(seconds / 60)} 分钟前`;
  return `刚才（${ago}）你在 ${app}${shortTitle ? `「${shortTitle}」` : ''}。`;
}

/** 从窗口标题里估一个「正在做什么」，只用于旁白措辞，不参与判断。 */
export function inferActivity(appName, windowTitle) {
  const app = String(appName ?? '').toLowerCase();
  const title = String(windowTitle ?? '');
  if (app.includes('word') || app.includes('pages')) return 'writing';
  if (app.includes('zotero') || app.includes('marginnote')) return 'reading';
  if (app.includes('chrome') || app.includes('safari') || app.includes('firefox')) return 'browsing';
  if (app.includes('preview')) return 'reading';
  if (/\.pdf/i.test(title)) return 'reading';
  if (app.includes('code') || app.includes('cursor') || app.includes('intellij')) return 'coding';
  return 'other';
}
