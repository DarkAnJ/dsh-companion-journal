/**
 * 拼图布局：行高按变化密度分配，格子不重叠、铺满画布。
 *
 *   node test/sheet.test.js
 *
 * @module dsh-companion-journal/test/sheet
 */

import { layoutSheet, salienceOf } from '../lib/sheet.js';

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

function eq(actual, expected, label = '') {
  if (actual !== expected) throw new Error(`${label} 期望 ${expected}，实际 ${actual}`);
}

check('布局：格子铺满画布且不重叠', () => {
  const frames = Array.from({ length: 9 }, (_, i) => ({ t: i * 2000, block: 0.05, ratio: 0.02, diff: 0.01 }));
  const layout = layoutSheet(frames, { width: 2160, height: 1350 });
  eq(layout.cells.length, 9);
  const area = layout.cells.reduce((sum, cell) => sum + cell.w * cell.h, 0);
  eq(area, 2160 * 1350, '面积应正好等于画布');
  // 行内首尾相接、行间不重叠
  for (const cell of layout.cells) {
    ok(cell.w > 0 && cell.h > 0, '格子不能是 0');
    ok(cell.x + cell.w <= 2160, '不能超出画布宽');
    ok(cell.y + cell.h <= 1350, '不能超出画布高');
  }
});

check('密度高的行更高（行高 ∝ 平均变化量）', () => {
  const quiet = [0, 1, 2].map((i) => ({ t: i, block: 0.01, ratio: 0.002, diff: 0.0005 }));
  const busy = [3, 4, 5].map((i) => ({ t: i, block: 0.30, ratio: 0.20, diff: 0.05 }));
  const layout = layoutSheet([...quiet, ...busy], { width: 2160, height: 1350 });
  const quietH = layout.cells.find((c) => c.index === 0).h;
  const busyH = layout.cells.find((c) => c.index === 5).h;
  ok(busyH > quietH * 2, `变化大的行应明显更高：${busyH} vs ${quietH}`);
});

check('行内宽度按信息量分配', () => {
  const quiet = { t: 0, block: 0.01, ratio: 0.002, diff: 0.0005 };
  const busy = { t: 1, block: 0.4, ratio: 0.3, diff: 0.06 };
  const layout = layoutSheet([quiet, busy], { width: 2000, height: 500 });
  ok(layout.cells[1].w > layout.cells[0].w * 3, `变化大的应更宽：${layout.cells[1].w} vs ${layout.cells[0].w}`);
  eq(layout.cells[0].w + layout.cells[1].w, 2000, '宽度要铺满');
});

check('少于一行时按实际帧数切列', () => {
  const layout = layoutSheet([{ t: 0 }, { t: 1 }], { width: 1000, height: 500 });
  eq(layout.cells.length, 2);
  eq(layout.cells[0].w, 500);
  eq(layout.cells[1].w, 500);
});

check('空输入返回空布局而不是抛错', () => {
  const layout = layoutSheet([], {});
  eq(layout.cells.length, 0);
});

check('信息量：静帧低于高变化帧', () => {
  ok(salienceOf({ block: 0.01, ratio: 0.001, diff: 0.0001 }) < salienceOf({ block: 0.3, ratio: 0.2, diff: 0.05 }));
});

if (failures.length > 0) {
  console.error(`✗ sheet ${failures.length} 项失败：`);
  for (const failure of failures) console.error('  - ' + failure);
  process.exitCode = 1;
} else {
  console.log(`✓ sheet ${passed} 项全过`);
}
