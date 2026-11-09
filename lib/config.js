/**
 * 配置读取：不做 schema 校验，只做「缺省 + 纠错 + 告警」。
 *
 * 为什么没有 `export const Config`（schemastery 那套）：本项目要能在
 * 「从目录 link 安装」这种最省事的形态下直接跑起来，而校验器是 peer 依赖，
 * 解析不到就会让整个插件在激活前失败。代价是配置写错不会被拦，
 * 所以这里把所有可纠正的错误都收集成 warnings，并在加载时打出来。
 *
 * @module dsh-companion-journal/lib/config
 */

export const DEFAULTS = {
  look: {
    // 「看一眼」的信息密度：short / normal / detailed（对应 简短 / 标准 / 详细）
    length: 'normal',
  },
  buddy: {
    // 自绘桌宠：静态立绘 + 气泡，独立进程。关掉它不影响 F7/F8（只是没气泡）。
    enabled: true,
    // 立绘 PNG 的路径；留空就用包内自带的那张。支持 ~ 开头。
    asset: '',
    // 立绘在屏幕上的边长（点）。按图片比例等比缩放，不会拉伸。
    size: 160,
    // 气泡与输入框的字号（点）。气泡高度按它自动算。
    fontSize: 13,
    // 气泡最多显示多少字（超出截断，完整内容仍在陪伴记录里）。
    maxBubbleChars: 400,
    // 是否在立绘上描出命中矩形（调试用；红框就是可点击范围）。平时关掉。
    debugHitbox: false,
    // 桌宠窗口是否可见（用户点右键「隐藏」后为 false，重启后保持）。
    visible: true,
    // 全局热键：由浮窗进程（真正的 AppKit 应用）注册，不需要 Automator。
    // 写法：F8 / option+shift+L / command+shift+space
    hotkeys: {
      look: 'F8',
      ask: 'F7',
    },
  },
  watch: {
    // 看一阵：采样间隔（毫秒），1 / 2 / 5 / 10 / 20 秒五档（气泡上可改，默认 2 秒）。
    intervalMs: 2000,
    // 锚点帧间隔：画面完全不变时也保证这么久留一张，避免时间线出现空洞。
    anchorMs: 60_000,
    // 留存策略：smart（默认，按内容判变 + 锚点）/ interval（每次采样都留，受每段 9 帧上限约束）
    retention: 'smart',
    // 画面判定：auto（文字太少 / 模型要求 / 高动态画面才看图）/ always（每段都看图）/ off（从不出图）
    visual: 'auto',
  },
  observe: {
    enabled: false,
    intervalMs: 5000,
    idleAfterSec: 120,
    minGapSec: 20,
    maxPerHour: 60,
    quietHours: ['23:00-08:00'],
    denyApps: ['1Password', 'Keychain Access', 'Mail', '钱包', '银行', 'Passwords'],
    denyTitlePatterns: ['password', '密码', '身份证', '银行卡', '私钥', 'seed phrase'],
  },
  hotkey: {
    enabled: true,
    // 默认避开系统常用组合；改这里即可换键。格式：修饰键 + 键名，如 option+shift+L / command+alt+space / F8
    spec: 'option+shift+L',
    // shortcut = 由 macOS 快捷指令绑定快捷键并调用 `dsh-bridge poke`（默认）；
    // listener = 插件自己拉起常驻监听（当前 macOS 对无签名二进制的限制下不可靠）。
    mode: 'shortcut',
  },
  capture: {
    target: 'front_window',
    maxWidth: 1600,
    retainTempMinutes: 0,
  },
  read: {
    maxChars: 12000,
    word: 'auto',
    pdf: 'auto',
    zotero: { enabled: false, baseUrl: 'http://127.0.0.1:23119' },
  },
  privacy: {
    redact: [],
    pauseOnSensitiveTitles: true,
  },
  spawn: {
    // 新建讨论会话用的 agent preset；留空/不存在时用 standard
    agentPreset: 'standard',
  },
  historyChat: {
    // 留空 = 用 DSH 的默认模型；想用更强的模型讨论就在这里指定
    model: { provider: '', model: '' },
    // always = 每轮都把缩略图放在消息前缀（靠 prompt cache 摊薄）；first = 只在首轮带；never = 纯文字
    reuseImage: 'always',
    // 推理 token 也算在这个额度里；被截断时回答会带明确标记
    // 推理也算进这个额度：给 4000 时模型偶尔全花在思考上，正文一个字都没有。
    maxTokens: 8000,
  },
  history: {
    path: '~/.dsh/dsh-companion-journal/history.jsonl',
    // full = 缩略图 + 原图（原图转 JPEG 压缩，点开看细节）；thumb = 只存缩略图；none = 不存图
    keepImages: 'full',
    maxThumbWidth: 360,
    retentionDays: 90,
  },
  http: {
    enabled: true,
  },
};

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeSection(defaults, provided, sectionName, warnings) {
  if (provided === undefined) return { ...defaults };
  if (!isPlainObject(provided)) {
    warnings.push(`${sectionName} 应该是对象，已忽略并改用默认值`);
    return { ...defaults };
  }
  const out = { ...defaults };
  for (const [key, value] of Object.entries(provided)) {
    if (!(key in defaults)) {
      warnings.push(`${sectionName}.${key} 不是已知配置项，已忽略`);
      continue;
    }
    const base = defaults[key];
    if (isPlainObject(base)) {
      if (isPlainObject(value)) out[key] = { ...base, ...value };
      else warnings.push(`${sectionName}.${key} 应该是对象，已忽略`);
      continue;
    }
    if (Array.isArray(base)) {
      if (Array.isArray(value)) out[key] = value.filter((x) => typeof x === 'string');
      else warnings.push(`${sectionName}.${key} 应该是字符串数组，已忽略`);
      continue;
    }
    if (typeof base === 'number') {
      const num = Number(value);
      if (Number.isFinite(num)) out[key] = num;
      else warnings.push(`${sectionName}.${key} 应该是数字，已忽略`);
      continue;
    }
    if (typeof base === 'string') {
      if (typeof value === 'string' && value.trim() !== '') out[key] = value;
      else warnings.push(`${sectionName}.${key} 应该是非空字符串，已忽略`);
      continue;
    }
    if (typeof base === 'boolean') {
      if (typeof value === 'boolean') out[key] = value;
      else warnings.push(`${sectionName}.${key} 应该是布尔值，已忽略`);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** 归一化 + 收集告警。返回的 warnings 会被 index.js 写进日志。 */
export function normalizeConfig(raw) {
  const warnings = [];
  const provided = isPlainObject(raw) ? raw : {};
  const config = {
    look: mergeSection(DEFAULTS.look, provided.look, 'look', warnings),
    buddy: mergeSection(DEFAULTS.buddy, provided.buddy, 'buddy', warnings),
    observe: mergeSection(DEFAULTS.observe, provided.observe, 'observe', warnings),
    hotkey: mergeSection(DEFAULTS.hotkey, provided.hotkey, 'hotkey', warnings),
    capture: mergeSection(DEFAULTS.capture, provided.capture, 'capture', warnings),
    watch: mergeSection(DEFAULTS.watch, provided.watch, 'watch', warnings),
    read: mergeSection(DEFAULTS.read, provided.read, 'read', warnings),
    privacy: mergeSection(DEFAULTS.privacy, provided.privacy, 'privacy', warnings),
    spawn: mergeSection(DEFAULTS.spawn, provided.spawn, 'spawn', warnings),
    historyChat: mergeSection(DEFAULTS.historyChat, provided.historyChat, 'historyChat', warnings),
    history: mergeSection(DEFAULTS.history, provided.history, 'history', warnings),
    http: mergeSection(DEFAULTS.http, provided.http, 'http', warnings),
  };
  // zotero 是嵌套对象，mergeSection 只做一层，这里单独补默认值。
  config.read.zotero = { ...DEFAULTS.read.zotero, ...(isPlainObject(config.read.zotero) ? config.read.zotero : {}) };

  if (config.observe.intervalMs < 5000) {
    config.observe.intervalMs = 5000;
    warnings.push('observe.intervalMs 小于 5000，已抬到 5000（更密的采样没有信息增益，只是在烧 CPU）');
  }
  if (config.observe.maxPerHour < 1) {
    config.observe.maxPerHour = 1;
    warnings.push('observe.maxPerHour 小于 1，已抬到 1');
  }
  return { config, warnings };
}
