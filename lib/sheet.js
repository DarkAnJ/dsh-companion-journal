/**
 * 画面拼图：把一段里挑出来的帧拼成一张图，**格子的高度按变化密度分配**。
 *
 * 为什么不固定九宫格：固定宫格假设每帧同样重要。屏幕录制里恰恰相反——
 * 一页 PPT 停 20 秒（1 帧就够）和一段连续滚动的代码（每 2 秒都在变）混在一段里时，
 * 均分格子等于把信息量低的那帧放大、信息量高的那帧压扁。
 *
 * v1 的折中：按时间顺序分行，**行高 ∝ 该行平均变化量**，行内等宽。
 * 这已经能把「哪里开始变快」直接看出来，又不用实现完整的按行 DP 打包。
 *
 * @module dsh-companion-journal/lib/sheet
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { bridgePath, runProcess } from './native.js';

/** 一行最多放几帧。 */
const MAX_PER_ROW = 3;

/** 一帧的「信息量」：局部块变化为主，整帧占比为辅。 */
export function salienceOf(frame) {
  const block = Number(frame?.block ?? 0);
  const ratio = Number(frame?.ratio ?? 0);
  const diff = Number(frame?.diff ?? 0);
  return 0.35 + block * 1.2 + ratio * 1.5 + diff * 4;
}

/**
 * 算拼图布局（纯函数，便于测试）。
 *
 * @param {Array<object>} frames 已按时间排序
 * @param {{width?: number, height?: number, perRow?: number}} [options]
 * @returns {{width: number, height: number, cells: Array<{index:number,x:number,y:number,w:number,h:number}>}}
 */
export function layoutSheet(frames, { width = 2160, height = 1350, perRow = MAX_PER_ROW } = {}) {
  const list = Array.isArray(frames) ? frames.filter(Boolean) : [];
  if (list.length === 0) return { width, height, cells: [] };
  const rows = [];
  for (let i = 0; i < list.length; i += perRow) {
    rows.push(list.slice(i, i + perRow));
  }
  // 行高 ∝ 该行的平均信息量；再归一化到画布高度。
  const weights = rows.map((row) => row.reduce((sum, frame) => sum + salienceOf(frame), 0) / row.length);
  const total = weights.reduce((sum, one) => sum + one, 0) || 1;
  const cells = [];
  let y = 0;
  rows.forEach((row, rowIndex) => {
    const rowHeight = Math.max(1, Math.round((weights[rowIndex] / total) * height));
    // 行内宽度也按信息量分配：变化大的那帧给更宽的格子（行高已经按行平均分过一轮）。
    const rowWeights = row.map((frame) => salienceOf(frame));
    const rowTotal = rowWeights.reduce((sum, one) => sum + one, 0) || 1;
    let x = 0;
    row.forEach((frame, index) => {
      const last = index === row.length - 1;
      const cellWidth = last
        ? width - x
        : Math.max(1, Math.round((rowWeights[index] / rowTotal) * width));
      cells.push({
        index: list.indexOf(frame),
        x,
        y,
        w: cellWidth,
        h: rowHeight,
      });
      x += cellWidth;
    });
    y += rowHeight;
  });
  return { width, height, cells };
}

/**
 * 把布局画成 PNG。
 *
 * @param {object} ctx 宿主上下文（subprocess）
 * @param {Array<object>} frames 需要带 `path`
 * @param {string} out 输出路径
 * @param {object} [options] 画布尺寸
 */
export async function renderSheet(ctx, { frames, out, width = 2160, height = 1350 }) {
  const layout = layoutSheet(frames, { width, height });
  if (layout.cells.length === 0) return { ok: false, reason: '没有可拼的帧' };
  const spec = {
    width: layout.width,
    height: layout.height,
    out,
    cells: layout.cells.map((cell) => ({
      ...cell,
      path: String(frames[cell.index]?.path ?? ''),
    })),
  };
  const specPath = `${out}.json`;
  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(specPath, JSON.stringify(spec));
  } catch (error) {
    return { ok: false, reason: `写拼图描述失败：${String(error?.message ?? error)}` };
  }
  const result = await runProcess(ctx, [bridgePath, 'sheet', '--spec', specPath], { timeoutMs: 20000 });
  await unlink(specPath).catch(() => {});
  if (result.code !== 0) {
    return { ok: false, reason: `拼图失败：${result.stderr.trim().slice(0, 160)}` };
  }
  return { ok: true, path: out, cells: layout.cells.length };
}
