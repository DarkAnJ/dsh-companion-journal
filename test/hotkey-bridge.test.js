/**
 * 热键监听链路的集成测试：真起一个常驻监听进程，模拟一次按键写入事件文件，
 * 验证插件侧的 fs.watch 能把事件送达回调。
 *
 * 不测「物理按键是否被 Carbon 捕获」——那需要人按，测试里只能覆盖到文件这一环，
 * 但这一环正是最容易写错的地方（fs/promises 的 watch 是 AsyncIterator，没有 .on）。
 *
 *   node test/hotkey-bridge.test.js
 *
 * @module dsh-companion-journal/test/hotkey-bridge
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { startBridgeHotkey } from '../lib/hotkey.js';
import { bridgePath } from '../lib/native.js';

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${String(error?.message ?? error)}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await check('起监听 → 写入事件 → 回调被调用 → dispose 后不再响应', async () => {
  const ctx = { get: () => undefined }; // 没有 subprocess 时走 node spawn 这条路
  const eventsFile = `/tmp/dsh-companion-journal-it-${process.pid}.jsonl`;
  writeFileSync(eventsFile, '');   // 快捷指令模式：文件由外部（快捷指令）维护
  let pressed = 0;
  const started = await startBridgeHotkey(ctx, {
    spec: 'option+shift+L',
    binPath: bridgePath,
    eventsFile,
    onPress: () => {
      pressed += 1;
    },
    spawn: false,
    logger: { warn() {}, info() {} },
  });
  if (!started.ok) throw new Error(`监听没起来：${started.reason}`);
  await sleep(700);
  appendFileSync(eventsFile, '{"event":"hotkey","at":1}\n');
  await sleep(500);
  started.dispose();
  await sleep(300);
  if (pressed < 1) throw new Error('写入事件后回调没有被调用');

  // dispose 之后再有事件也不该触发
  const before = pressed;
  try {
    appendFileSync(eventsFile, '{"event":"hotkey","at":2}\n');
  } catch {
    /* 文件可能已被清理，这正是预期 */
  }
  await sleep(300);
  if (pressed !== before) throw new Error('dispose 后仍在响应事件');
});

if (failures.length > 0) {
  console.error(`✗ hotkey-bridge ${failures.length} 项失败：`);
  for (const failure of failures) console.error('  - ' + failure);
  process.exitCode = 1;
} else {
  console.log(`✓ hotkey-bridge ${passed} 项全过`);
}
