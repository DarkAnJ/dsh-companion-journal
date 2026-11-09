/**
 * 桌宠入口与收集气泡的按钮覆盖：这些是「用户点得到的地方」，坏了没有日志，
 * 只能用源码级断言钉住（原生菜单项、气泡里的动作 id、宿主对动作的分发）。
 *
 *   node test/native-menu.test.js
 *
 * @module dsh-companion-journal/test/native-menu
 */

import { readFileSync } from 'node:fs';

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

function ok(value, label = '') {
  if (!value) throw new Error(`${label} 期望为真`);
}

const swift = readFileSync(new URL('../buddy/Buddy.swift', import.meta.url), 'utf8');
const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

check('右键菜单有「看一眼并提问」且发出 ask 动作', () => {
  ok(swift.includes('"看一眼并提问"'), '菜单项缺失');
  ok(/@objc private func menuAsk\(\) \{ appendPress\(action: "ask"/.test(swift), 'menuAsk 应发出 ask');
});

check('右键菜单有「看一阵」且发出 watch-toggle', () => {
  ok(swift.includes('"看一阵"'), '菜单项缺失');
  ok(/@objc private func menuWatch\(\) \{ appendPress\(action: "watch-toggle"/.test(swift), 'menuWatch 应发出 watch-toggle');
});

check('「记下这一帧」只在录制气泡里，不进右键菜单', () => {
  ok(!swift.includes('"记下这一帧"'), '菜单项应该没有');
  ok(host.includes("id: 'watch-shot', label: '记一帧'"), '录制气泡里要有「记一帧」');
  ok(host.includes("if (action === 'watch-shot')"), '动作处理要保留');
});

// 准备阶段要跟随活动窗口；按开始才锁定（用户明确要求）。
check('看一阵：准备期跟随前台窗口（事件驱动，不轮询）', () => {
  ok(host.includes('refreshPendingTarget('), '缺少目标刷新');
  ok(host.includes('sameWatchTarget('), '缺少目标比较');
  ok(host.includes("action === 'front-changed'"), '应响应应用激活事件');
  ok(!host.includes('}, 1200);'), '不该再有 1.2 秒轮询');
  ok(swift.includes('didActivateApplicationNotification'), '浮窗要监听应用激活');
  ok(swift.includes('appendPress(action: "front-changed"'), '激活时发事件');
});

check('右键菜单叫「看几眼」', () => {
  ok(swift.includes('"看几眼"'), '菜单项应改名');
  ok(!swift.includes('"多画面看一眼"'), '旧名字应已删除');
});

check('看一阵：点菜单直接出录制气泡，第一个按钮是「开始」', () => {
  ok(host.includes('async function prepareWatch('), '缺少准备阶段');
  ok(host.includes('async function showWatchIdleBubble('), '缺少「未开始」气泡');
  ok(host.includes("{ id: 'watch-begin', label: '开始' }"), '第一个按钮应是「开始」');
  ok(!host.includes("id: 'watch-cancel'"), '不该再有「取消」按钮');
  ok(host.includes("id: 'watch-stop', label: '停止'"), '未开始时也要有停止（布局一致）');
  ok(host.includes('async function beginWatch('), '缺少真正启动的函数');
});

check('收集气泡有「提问」按钮', () => {
  ok(host.includes("{ id: 'collect-ask', label: '提问' }"), '气泡动作缺失');
});

check('宿主把 collect-ask 当成 F7 处理', () => {
  ok(host.includes("action === 'ask' || action === 'collect-ask'"), '分发条件缺 collect-ask');
  ok(/action === 'ask' \? 'f7' : 'f8'|collect-ask' \? 'f7' : 'f8'/.test(host), '模式映射缺失');
});

if (failures.length > 0) {
  console.error(`✗ native-menu ${failures.length} 项失败：`);
  for (const failure of failures) console.error('  - ' + failure);
  process.exitCode = 1;
} else {
  console.log(`✓ native-menu ${passed} 项全过`);
}
