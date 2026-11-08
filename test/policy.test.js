/**
 * 策略层单测：只用 node 跑，不需要 DSH、不需要 macOS、不需要授权。
 *
 *   node test/policy.test.js
 *
 * 这里刻意不引 node:test：桌面端自带的 node 版本与用户 PATH 上的不一定一致，
 * 一个自带断言的脚本在任何版本上都能跑，比"测试跑不起来"有用得多。
 *
 * @module dsh-companion-journal/test/policy
 */

import {
  RateLimiter,
  decideVisibility,
  inferActivity,
  inQuietHours,
  isHostApp,
  narrateLastSeen,
  matchesAny,
  narrateScene,
  narrateTransition,
  pickRecentWindow,
  pickSwitchLine,
  parseQuietRange,
  redact,
  sceneCategory,
  SWITCH_LINES,
  sceneSignature,
} from '../lib/policy.js';
import { DEFAULTS, normalizeConfig } from '../lib/config.js';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${String(error?.message ?? error)}`);
  }
}

function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label} 期望 ${e}，实际 ${a}`);
}

function ok(value, label = '') {
  if (!value) throw new Error(`${label} 期望为真`);
}

// ── 静默时段 ────────────────────────────────────────────────────────────────

check('parseQuietRange 解析正常区间', () => {
  eq(parseQuietRange('23:00-08:00'), { start: 1380, end: 480 });
  eq(parseQuietRange('乱写'), null);
  eq(parseQuietRange('10:00-10:00'), null);
});

check('静默时段跨零点', () => {
  const at = (h, m) => new Date(2026, 0, 1, h, m, 0);
  ok(inQuietHours(at(23, 30), ['23:00-08:00']), '23:30 应在静默内');
  ok(inQuietHours(at(2, 0), ['23:00-08:00']), '02:00 应在静默内');
  ok(!inQuietHours(at(12, 0), ['23:00-08:00']), '12:00 不该在静默内');
  ok(!inQuietHours(at(8, 0), ['23:00-08:00']), '08:00 是边界，不该在静默内');
});

check('静默时段普通区间', () => {
  const at = (h, m) => new Date(2026, 0, 1, h, m, 0);
  ok(inQuietHours(at(13, 0), ['12:00-14:00']), '13:00 在区间内');
  ok(!inQuietHours(at(14, 0), ['12:00-14:00']), '14:00 是右开边界');
});

// ── 黑名单 ──────────────────────────────────────────────────────────────────

check('黑名单是子串、大小写不敏感', () => {
  ok(matchesAny('1Password 7', ['1password']), '大小写应忽略');
  ok(matchesAny('Passwords', ['Passwords']));
  ok(!matchesAny('Word', ['1Password']));
  ok(!matchesAny('', ['anything']));
  ok(!matchesAny('Word', null));
});

// ── 可见性判定 ──────────────────────────────────────────────────────────────

check('可见性：命中的应用黑名单', () => {
  const verdict = decideVisibility({
    appName: '1Password',
    windowTitle: '保险库',
    config: DEFAULTS,
  });
  eq(verdict.ok, false);
  eq(verdict.reason, 'deny-app');
});

check('可见性：命中敏感标题', () => {
  const verdict = decideVisibility({
    appName: 'Chrome',
    windowTitle: '输入密码 - 某站点',
    config: DEFAULTS,
  });
  eq(verdict.ok, false);
  eq(verdict.reason, 'sensitive-title');
});

check('可见性：关掉敏感标题拦截后放行', () => {
  const config = { ...DEFAULTS, privacy: { ...DEFAULTS.privacy, pauseOnSensitiveTitles: false } };
  // 必须给固定时间：默认静默时段是 23:00–08:00，晚上跑测试会误判成 quiet-hours。
  const verdict = decideVisibility({ appName: 'Chrome', windowTitle: '密码', config, now: new Date(2026, 0, 1, 15, 0, 0) });
  eq(verdict.ok, true);
});

check('可见性：正常窗口放行', () => {
  const verdict = decideVisibility({
    appName: 'Microsoft Word',
    windowTitle: '开题报告.docx',
    config: DEFAULTS,
    now: new Date(2026, 0, 1, 15, 0, 0),
  });
  eq(verdict.ok, true);
});

// ── 限频 ────────────────────────────────────────────────────────────────────

check('限频：最小间隔', () => {
  const limiter = new RateLimiter({ minGapSec: 300, maxPerHour: 6 });
  const t0 = 1_000_000;
  ok(limiter.canEmit(t0), '首次应放行');
  limiter.record(t0);
  ok(!limiter.canEmit(t0 + 100_000), '100s 后应被间隔挡住');
  ok(limiter.canEmit(t0 + 301_000), '301s 后应放行');
});

check('限频：小时上限', () => {
  const limiter = new RateLimiter({ minGapSec: 1, maxPerHour: 3 });
  const t0 = 2_000_000;
  for (let i = 0; i < 3; i++) {
    ok(limiter.canEmit(t0 + i * 1000), `第 ${i + 1} 次应放行`);
    limiter.record(t0 + i * 1000);
  }
  ok(!limiter.canEmit(t0 + 4000), '超出小时上限应拒绝');
  ok(limiter.canEmit(t0 + 3600_000 + 5000), '滑出窗口后应放行');
});

// ── 场景签名 ────────────────────────────────────────────────────────────────

check('场景签名：同场景稳定', () => {
  const a = sceneSignature({ app: 'Word', title: 'a.docx', idle: 10 });
  const b = sceneSignature({ app: 'Word', title: 'a.docx', idle: 55 });
  eq(a, b, '同一分钟内空闲变化不该产生新签名');
});

check('场景签名：换应用或标题才变', () => {
  const base = sceneSignature({ app: 'Word', title: 'a.docx', idle: 10 });
  ok(sceneSignature({ app: 'Chrome', title: 'a.docx', idle: 10 }) !== base);
  ok(sceneSignature({ app: 'Word', title: 'b.docx', idle: 10 }) !== base);
  ok(sceneSignature({ app: 'Word', title: 'a.docx', idle: 70 }) !== base, '跨过整分钟应产生新签名');
});

// ── 脱敏 ────────────────────────────────────────────────────────────────────

check('脱敏：忽略大小写并处理正则元字符', () => {
  eq(redact('Password: 123', ['password']), '[已脱敏]: 123');
  eq(redact('cost is C++ here', ['C++']), 'cost is [已脱敏] here');
  eq(redact('nothing', []), 'nothing');
});

// ── 旁白 ────────────────────────────────────────────────────────────────────

check('旁白：三种空闲档位的措辞不同', () => {
  const busy = narrateScene({ appName: 'Word', windowTitle: '稿子.docx', idleSeconds: 5 });
  const paused = narrateScene({ appName: 'Word', windowTitle: '稿子.docx', idleSeconds: 200 });
  const away = narrateScene({ appName: 'Word', windowTitle: '稿子.docx', idleSeconds: 700 });
  ok(busy.includes('你在看'), busy);
  ok(paused.includes('停了一会儿'), paused);
  ok(away.includes('很久没动'), away);
  eq(narrateScene({ appName: '' }), '');
});

check('活动推断', () => {
  eq(inferActivity('Microsoft Word', 'x.docx'), 'writing');
  eq(inferActivity('Zotero', 'x'), 'reading');
  eq(inferActivity('Google Chrome', 'x'), 'browsing');
  eq(inferActivity('Finder', 'x'), 'other');
});

// ── 配置 ────────────────────────────────────────────────────────────────────

check('配置：缺省值', () => {
  const { config, warnings } = normalizeConfig(undefined);
  eq(warnings.length, 0);
  eq(config.observe.enabled, false);
  eq(config.observe.intervalMs, 5000);
  eq(config.buddy.enabled, true);
  eq(config.buddy.asset, '');
  eq(config.read.zotero.enabled, false);
});

check('配置：未知键告警但不崩', () => {
  const { config, warnings } = normalizeConfig({ observe: { nope: 1 } });
  ok(warnings.some((w) => w.includes('observe.nope')), JSON.stringify(warnings));
  eq(config.observe.intervalMs, 5000);
});

check('配置：过小的间隔被抬到下限', () => {
  const { config, warnings } = normalizeConfig({ observe: { intervalMs: 100 } });
  eq(config.observe.intervalMs, 5000);
  ok(warnings.some((w) => w.includes('intervalMs')), JSON.stringify(warnings));
});

check('配置：错误类型不污染默认值', () => {
  const { config, warnings } = normalizeConfig({ observe: { enabled: 'yes' }, read: { maxChars: 'abc' } });
  eq(config.observe.enabled, false, '字符串不该被当成 true');
  eq(config.read.maxChars, 12000);
  ok(warnings.length >= 2, JSON.stringify(warnings));
});

check('配置：zotero 嵌套默认值合并', () => {
  const { config } = normalizeConfig({ read: { zotero: { baseUrl: 'http://127.0.0.1:9999' } } });
  eq(config.read.zotero.baseUrl, 'http://127.0.0.1:9999');
  eq(config.read.zotero.enabled, false);
});

// ── 活动类别与跨类别旁白（主动找你）──────────────────────────────────────────

check('类别：浏览器靠标题分，GitHub 是 work、B 站是 fun', () => {
  eq(sceneCategory({ appName: 'Google Chrome', windowTitle: 'Understand-Anything · GitHub' }), 'work');
  eq(sceneCategory({ appName: 'Safari', windowTitle: '【教程】桌宠一键部署_哔哩哔哩_bilibili' }), 'fun');
});

check('类别：应用名够用时不必看标题', () => {
  eq(sceneCategory({ appName: 'Microsoft Word', windowTitle: '随便什么.docx' }), 'work');
  eq(sceneCategory({ appName: 'Zotero', windowTitle: 'Fertigation' }), 'work');
  eq(sceneCategory({ appName: '微信读书', windowTitle: '同济微积分' }), 'fun', '微信读书带「微信」，但它是看书');
  eq(sceneCategory({ appName: '飞书', windowTitle: '群聊' }), 'social');
  eq(sceneCategory({ appName: '影子路由器', windowTitle: '' }), 'other');
});

check('旁白：办公→娱乐、娱乐→办公各有自己的说法', () => {
  const toFun = narrateTransition({
    category: 'fun',
    previous: { category: 'work', appName: 'Microsoft Word' },
    scene: { appName: 'Safari', windowTitle: 'bilibili' },
  });
  ok(toFun.includes('Safari'), toFun);
  ok(/歇|放松/.test(toFun), toFun);

  const toWork = narrateTransition({
    category: 'work',
    previous: { category: 'fun', appName: 'Safari' },
    scene: { appName: 'Microsoft Word', windowTitle: '论文' },
  });
  ok(toWork.includes('Word'), toWork);
  ok(toWork.includes('回到') && toWork.includes('Safari'), toWork);
});

check('旁白：同一类别内的切换不出声（否则就是骚扰）', () => {
  eq(narrateTransition({
    category: 'work',
    previous: { category: 'work', appName: 'Microsoft Word' },
    scene: { appName: 'Zotero', windowTitle: '条目' },
  }), '');
  eq(narrateTransition({
    category: 'other',
    previous: { category: 'other', appName: 'Finder' },
    scene: { appName: 'Finder', windowTitle: '下载' },
  }), '');
});

// ── 自己的窗口是透明的 / 「看一眼」回看别处 ─────────────────────────────────

check('DSH 自己的窗口不算「你在干什么」', () => {
  ok(isHostApp({ bundleId: 'com.deepseek.dsh', appName: 'DeepSeek Harness' }));
  ok(isHostApp({ bundleId: '', appName: 'DeepSeek Harness' }), '按名字也要认出来');
  ok(!isHostApp({ bundleId: 'com.apple.Safari', appName: 'Safari' }));
});

check('「看一眼」报的是别处的采样，不是 DSH 自己', () => {
  const now = 1_700_000_000_000;
  const line = narrateLastSeen({ appName: 'Safari', windowTitle: 'bilibili', at: now - 30_000 }, now);
  ok(line.includes('Safari') && line.includes('bilibili'), line);
  ok(line.includes('30 秒前'), line);
  eq(narrateLastSeen(null, now), '我还没看到你在别的地方做什么。');
  ok(
    narrateLastSeen({ appName: 'Word', windowTitle: 'x'.repeat(80), at: now - 180_000 }, now).includes('…'),
    '超长标题应截断',
  );
});

// ── 切换台词池 ──────────────────────────────────────────────────────────────

check('切换台词：不描述窗口内容（不出现应用名占位符）', () => {
  for (const line of SWITCH_LINES) {
    ok(typeof line === 'string' && line.length > 0);
    ok(!/\{|\}|word|safari|chrome/i.test(line), `台词不该含窗口信息：${line}`);
  }
});

check('切换台词：不会连着说同一句', () => {
  for (let i = 0; i < 50; i += 1) {
    const picked = pickSwitchLine('又换啦？', () => Math.random());
    ok(picked !== '又换啦？', '相邻两句不应重复');
  }
  eq(pickSwitchLine(undefined, () => 0), SWITCH_LINES[0]);
  eq(pickSwitchLine(SWITCH_LINES[0], () => 0), SWITCH_LINES[1]);
});

check('配置默认值：采样 5s、最小间隔 20s、每小时 60 句', () => {
  eq(DEFAULTS.observe.intervalMs, 5000);
  eq(DEFAULTS.observe.minGapSec, 20);
  eq(DEFAULTS.observe.maxPerHour, 60);
});

// ── 找「你刚才在用的那个窗口」 ────────────────────────────────────────────────

check('看一眼：跳过 DSH 自己和小浮窗，挑最近那个', () => {
  const host = isHostApp;
  const windows = [
    { windowId: 1, ownerName: 'DeepSeek Harness', bundleId: 'com.deepseek.dsh', onScreen: true, layer: 0, bounds: { w: 1280, h: 820 }, title: 'DSH' },
    { windowId: 2, ownerName: '小贴纸', bundleId: 'x.panel', onScreen: true, layer: 0, bounds: { w: 120, h: 90 }, title: '贴纸' },
    { windowId: 3, ownerName: 'Microsoft Word', bundleId: 'com.microsoft.Word', onScreen: true, layer: 0, bounds: { w: 900, h: 700 }, title: '论文.docx' },
  ];
  const picked = pickRecentWindow(windows, { host });
  eq(picked?.windowId, 3);
  eq(picked?.appName, 'Microsoft Word');
  eq(pickRecentWindow([], { host }), null);
});

// ── 汇总 ────────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`✗ ${failures.length} 项失败（通过 ${passed} 项）`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`✓ policy/config ${passed} 项全过`);
