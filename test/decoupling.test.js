/**
 * 解耦测试：确保插件不再依赖 dsh-pet。
 *
 * 这条测试存在的意义：我们曾经把「说话」全押在 dsh-pet 的 HTTP 接口上，
 * 它一升级我们就可能静默失效。现在输出面是自己画的浮窗——如果再有人
 * 把 dsh-pet 引回来（哪怕只是一行注释里的调用），这条测试会立刻失败。
 *
 *   node test/decoupling.test.js
 *
 * @module dsh-companion-journal/test/decoupling
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
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

function ok(value, label = '') {
  if (!value) throw new Error(`${label} 期望为真`);
}

async function collect(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collect(full)));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

await check('源码里不再出现 dsh-pet 的调用或地址', async () => {
  const files = await collect(join(ROOT, 'lib'));
  const hits = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (text.includes('dsh-pet') || text.includes('petId')) hits.push(file.replace(ROOT, ''));
  }
  ok(hits.length === 0, `仍有引用：${hits.join(', ')}`);
});

await check('不再分发被删除的 pet 模块', async () => {
  const files = await collect(join(ROOT, 'lib'));
  ok(!files.some((f) => f.endsWith('pet.js')), 'lib/pet.js 应该已经删除');
});

await check('浮窗自己的入口存在', async () => {
  const source = await readFile(join(ROOT, 'buddy', 'Buddy.swift'), 'utf8');
  ok(source.includes('NSApplication.shared'), '浮窗应该是原生 AppKit 进程');
  ok(!source.includes('electron-helper'), '不应该依赖 Electron helper');
});

await check('插件把输出面指向浮窗', async () => {
  const index = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8');
  ok(index.includes('setSurface('), 'apply() 应该注入输出面');
  ok(index.includes('startBuddy('), 'apply() 应该拉起浮窗');
});

if (failures.length > 0) {
  console.error(`✗ decoupling ${failures.length} 项失败：`);
  for (const failure of failures) console.error('  - ' + failure);
  process.exitCode = 1;
} else {
  console.log(`✓ decoupling ${passed} 项全过`);
}
