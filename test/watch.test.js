/**
 * 看一阵的纯逻辑：缩略帧差分、选帧、记账。
 *
 *   node test/watch.test.js
 *
 * 这些函数不碰系统，坏了会直接让「画面变了没」判错——那是整个录制的基础。
 *
 * @module dsh-companion-journal/test/watch
 */

import { readFileSync } from 'node:fs';
import {
  changedRatio,
  decideRetention,
  effectiveElapsed,
  estimateTokens,
  maxBlockDiff,
  formatDuration,
  formatTokens,
  freshLines,
  meanDiff,
  median,
  parseBmp,
  pickFrames,
  shouldKeep,
  visualReasonFor,
  windowSizeChanged,
  TOKEN_WARNINGS,
  INTERVALS,
} from '../lib/watch.js';

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

/** 造一个 sips 风格的 32 位 BMP（自上而下）。 */
function makeBmp(width, height, rgbAt) {
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(54 + width * height * 4, 2);
  header.writeUInt32LE(54, 10);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(-height, 22); // 负高度 = 自上而下
  header.writeUInt16LE(32, 28);
  const body = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = rgbAt(x, y);
      const at = (y * width + x) * 4;
      body[at] = b;
      body[at + 1] = g;
      body[at + 2] = r;
      body[at + 3] = 255;
    }
  }
  return Buffer.concat([header, body]);
}

check('解析 BMP：颜色通道正确、自上而下', () => {
  const buffer = makeBmp(2, 2, (x, y) => (x === 0 && y === 0 ? [255, 0, 0] : [0, 0, 0]));
  const parsed = parseBmp(buffer);
  ok(parsed, '应能解析');
  eq(parsed.width, 2);
  eq(parsed.height, 2);
  eq(parsed.pixels[0], 255, '第一像素应是红');
  eq(parsed.pixels[1], 0);
  eq(parsed.pixels[2], 0);
});

check('非 BMP 返回 null（不抛）', () => {
  eq(parseBmp(Buffer.from('not a bmp at all')), null);
});

check('相同帧差异为 0，全黑对全白约为 1', () => {
  const black = parseBmp(makeBmp(4, 4, () => [0, 0, 0]));
  const white = parseBmp(makeBmp(4, 4, () => [255, 255, 255]));
  eq(meanDiff(black, black), 0);
  ok(meanDiff(black, white) > 0.98, `黑白差异应接近 1，实际 ${meanDiff(black, white)}`);
});

// 回归：视频窗口里 90% 是静态区域，均值差只有 1.8%（旧阈值 2% 判成「没变」），
// 但实际有 14.5% 的像素在变。所以判据要看「变化像素占比」，不能只看均值。
check('变化判据：静态帧不保留，视频帧保留', () => {
  const base = parseBmp(makeBmp(16, 16, (x, y) => (x < 14 ? [30, 30, 30] : [200, 40, 40])));
  const same = parseBmp(makeBmp(16, 16, (x, y) => (x < 14 ? [30, 30, 30] : [200, 40, 40])));
  // 只有右下角一小块在变：整体均值很小，但变化像素占比达到阈值
  const moved = parseBmp(makeBmp(16, 16, (x, y) => (x >= 14 && y >= 14 ? [250, 250, 250] : x < 14 ? [30, 30, 30] : [200, 40, 40])));
  ok(!shouldKeep(base, same), '完全没变不该保留');
  ok(shouldKeep(base, moved), '有像素在变就该保留');
  eq(shouldKeep(null, base), true, '第一帧总是保留');
  ok(changedRatio(base, moved) > 0, '变化占比应大于 0');
  eq(changedRatio(base, same), 0);
});

check('留存决策：变化帧 / 锚点帧 / 跳过', () => {
  // 静态画面：差值为 0，锚点没到 → 跳过
  eq(decideRetention({ diff: 0.0003, ratio: 0.002, recent: [0.0003, 0.0004], sinceLastMs: 5_000 }).keep, false);
  // 静态但距上一张超过锚点间隔 → 留一张锚点
  const anchor = decideRetention({ diff: 0.0003, ratio: 0.002, recent: [0.0003], sinceLastMs: 61_000 });
  eq(anchor.keep, true);
  eq(anchor.kind, 'anchor');
  // 局部变化（打字 / 改数字）：整帧占比很小，但块差很大 → 也算变化
  const local = decideRetention({ diff: 0.0005, ratio: 0.003, block: 0.12, recent: [0.0003], sinceLastMs: 2_000 });
  eq(local.keep, true, '局部变化应被识别');
  eq(local.kind, 'change');
  // 明显变化 → 变化帧
  const changed = decideRetention({ diff: 0.02, ratio: 0.15, recent: [0.0003], sinceLastMs: 2_000 });
  eq(changed.keep, true);
  eq(changed.kind, 'change');
  // 噪声场景：基线很高时，同一个小差值不再算变化（自适应）
  const noisy = decideRetention({ diff: 0.004, ratio: 0.008, recent: [0.01, 0.012, 0.009], sinceLastMs: 2_000 });
  eq(noisy.keep, false, '高噪声场景要抬高门槛');
});

check('局部块差：只有一小块在变也能测出来', () => {
  const base = parseBmp(makeBmp(16, 16, () => [20, 20, 20]));
  const corner = parseBmp(makeBmp(16, 16, (x, y) => (x < 4 && y < 4 ? [240, 240, 240] : [20, 20, 20])));
  ok(maxBlockDiff(base, corner, 8) > 0.5, '角落那一块应明显变化');
  ok(changedRatio(base, corner) < 0.1, '但整帧占比很小（说明确实需要局部信号）');
  eq(maxBlockDiff(base, base), 0);
});

check('中位数与锚点选帧优先', () => {
  eq(median([]), 0);
  eq(median([3, 1, 2]), 2);
  eq(median([4, 1, 3, 2]), 2.5);
  const frames = Array.from({ length: 12 }, (_, i) => ({
    t: i * 2000,
    diff: i % 3 === 0 ? 0.5 : 0.01,
    kind: i === 10 ? 'anchor' : 'change',
    path: 'f.png',
  }));
  const picked = pickFrames(frames, 3);
  ok(picked.some((one) => one.kind === 'anchor'), '锚点应优先保留');
  eq(picked.length, 3);
});

// 回归：分桶内只按平均差挑，会把「字幕变了但整帧差异很小」的帧淘汰掉。
check('分桶选帧按信息量（局部块差优先于整帧均值）', () => {
  const subtitle = { t: 2000, diff: 0.002, ratio: 0.03, block: 0.35, kind: 'change', path: 's' };
  const scroll = { t: 6000, diff: 0.05, ratio: 0.02, block: 0.02, kind: 'change', path: 'c' };
  const picked = pickFrames([subtitle, scroll], 1);
  eq(picked.length, 1);
  eq(picked[0].path, 's', '应选信息量更高的字幕帧，而不是均值更高的滚动帧');
});

check('手动帧优先于锚点与变化帧', () => {
  const frames = [
    { t: 0, diff: 0.9, kind: 'change', path: 'a' },
    { t: 1000, diff: 0.01, kind: 'manual', path: 'b' },
    { t: 2000, diff: 0.01, kind: 'anchor', path: 'c' },
    { t: 3000, diff: 0.8, kind: 'change', path: 'd' },
    { t: 4000, diff: 0.7, kind: 'change', path: 'e' },
  ];
  const picked = pickFrames(frames, 2);
  ok(picked.some((one) => one.kind === 'manual'), '手动帧必须保留');
  ok(picked.some((one) => one.kind === 'anchor'), '锚点次优先');
});

// 回归：段结束时才 OCR 会卡几秒；现在采样间隙里预取（并发 2），段结束只等剩余。
check('OCR 预取：帧落盘就排队，段结束等结果（源码级守卫）', () => {
  const source = readFileSync(new URL('../lib/watch.js', import.meta.url), 'utf8');
  ok(source.includes('const OCR_CONCURRENCY = 2'), '并发上限应为 2');
  ok(source.includes('queueOcr(frame)'), '抓帧成功后应立即排队 OCR');
  ok(source.includes('session.current.frames.length <= TEXT_FRAME_CAP'), 'OCR 预取要限制在文本帧预算内');
  ok(source.includes('if (frame.ocrReady) await frame.ocrReady'), '段结束应复用预取结果');
});

// 回归 2026-11-08 的宿主崩溃：收尾期间再点一次「停止」会重入 stop()，
// 第二次拿到的是已经置空的 session，读 s.startedAt 直接 TypeError 崩掉进程。
check('stop 幂等 + 收尾期间动作被拒（源码级守卫）', () => {
  const source = readFileSync(new URL('../lib/watch.js', import.meta.url), 'utf8');
  ok(source.includes('if (session.stopPromise) return session.stopPromise'), 'stop 必须幂等');
  ok(source.includes('session.stopping'), '收尾状态要能挡住重入');
  ok(source.includes('if (session === s) session = null'), '只有还是自己的会话才允许置空');
  ok(source.includes('if (win.needsVisual && !session?.stopping)'), '收尾期间不再发起看图调用');
});

// 录制中拖窗口大小：尺寸变化本身就是一次真实的内容变化，必须保留一帧；
// 缩略帧要按比例补边到 128×72，不能直接拉伸（否则比例一变就多出一次假变化）。
check('窗口尺寸变化判定 + 缩略帧按比例补边（源码级守卫）', () => {
  eq(windowSizeChanged({ width: 1280, height: 720 }, { width: 1280, height: 720 }), false);
  eq(windowSizeChanged({ width: 1280, height: 720 }, { width: 1000, height: 720 }), true);
  eq(windowSizeChanged(null, { width: 1, height: 1 }), false);
  const source = readFileSync(new URL('../lib/watch.js', import.meta.url), 'utf8');
  ok(source.includes("'--padToHeightWidth'"), '缩略帧要保持比例补边');
  ok(source.includes("if (changedSize) session.resizes += 1"), '尺寸变化要计数');
});

// 回归：字幕换一行也能让块差到 0.2，旧规则会给网课每 60 秒白出一张拼图。
check('高动态出图要同时满足「块差大 + 面积大」', () => {
  const base = { mode: 'auto', chars: 600, modelAsk: false, sinceLastSheetMs: 120_000 };
  eq(visualReasonFor({ ...base, maxBlock: 0.23, maxRatio: 0.02 }), '', '字幕型变化（面积小）不该出图');
  eq(visualReasonFor({ ...base, maxBlock: 0.23, maxRatio: 0.12 }), 'motion', '换页/切镜头（面积大）才出图');
});

// 回归：文本路径曾和图片共用 9 帧上限，长段丢字幕。
check('文本路径帧预算大于图片上限（源码级守卫）', () => {
  const source = readFileSync(new URL('../lib/watch.js', import.meta.url), 'utf8');
  ok(/TEXT_FRAME_CAP = \d+/.test(source), '应有独立的文本帧预算');
  ok(source.includes('pickFrames(session.current.frames, TEXT_FRAME_CAP)'), '文本路径应用 TEXT_FRAME_CAP');
  ok(source.includes('pickFrames(session.current?.frames ?? [], ANALYSIS_FRAME_CAP)'), '拼图仍用 9 帧上限');
});

// 回归：用户录视频时「没看画面」——因为文字（弹幕/比分板）够长，被判成「文字优先」。
check('画面判定：高动态画面即使文字够长也要看图（带节流）', () => {
  const base = { mode: 'auto', chars: 600, modelAsk: false, maxBlock: 0.21, maxRatio: 0.15 };
  eq(visualReasonFor({ ...base, sinceLastSheetMs: 120_000 }), 'motion', '视频画面应出图');
  eq(visualReasonFor({ ...base, sinceLastSheetMs: 10_000 }), '', '60 秒内不重复出图');
  eq(visualReasonFor({ ...base, maxBlock: 0.02, sinceLastSheetMs: 120_000 }), '', '静态画面不出图');
  eq(visualReasonFor({ mode: 'always', chars: 10, maxBlock: 0 }), 'text-empty', '文字为空优先报 text-empty');
  eq(visualReasonFor({ mode: 'always', chars: 600, maxBlock: 0 }), 'always');
  eq(visualReasonFor({ mode: 'off', chars: 0, maxBlock: 0.5 }), '');
  eq(visualReasonFor({ mode: 'auto', chars: 600, modelAsk: true, maxBlock: 0 }), 'model-flag');
});

check('选帧：不超过上限，且保证时间覆盖', () => {
  const frames = Array.from({ length: 15 }, (_, i) => ({ t: i * 2000, kept: true, diff: i === 7 ? 0.5 : 0.05, path: `f${i}.png` }));
  const picked = pickFrames(frames, 9);
  eq(picked.length, 9, '应裁到 9 帧');
  ok(picked.some((one) => one.t === 14000), '差异最大的那帧应当被选中');
  const times = picked.map((one) => one.t);
  ok(times[times.length - 1] - times[0] > 20000, '不能全挤在同一段');
});

check('选帧：少于上限时全留', () => {
  const frames = [{ t: 0, kept: true, diff: 0.1 }, { t: 2000, kept: true, diff: 0.2 }];
  eq(pickFrames(frames, 9).length, 2);
});

check('记账：文字与图片分别计价', () => {
  eq(estimateTokens({ chars: 1000, sheets: 0 }), 500);
  eq(estimateTokens({ chars: 0, sheets: 2 }), 3000);
  eq(estimateTokens({}), 0);
});

// 回归：连续录制时每段都把「播放量 / 标题」重新讲一遍——因为全量 OCR 都喂进去了。
check('增量文字：只留新行，重复行不喂给模型', () => {
  const seen = new Set(['哔哩哔哩', '324.3万播放', '英雄联盟赛事']);
  const first = freshLines('哔哩哔哩\n324.3万播放\n新弹幕：这波团打赢了', seen);
  eq(first.repeated, 2, '两行是重复的');
  ok(first.fresh.includes('新弹幕'), '新行应保留');
  ok(!first.fresh.includes('324.3万播放'), '重复行应剔除');
  const allRepeat = freshLines('哔哩哔哩\n324.3万播放', seen);
  eq(allRepeat.fresh, '', '全是重复时应为空（宿主据此跳过这次模型调用）');
  eq(freshLines('', seen).fresh, '');
});

// 回归：暂停时计时停住，但恢复后时间「跳」了——因为墙钟一直走。
check('暂停的时间不计入有效时长', () => {
  const startedAt = 1_000_000;
  eq(effectiveElapsed({ startedAt, at: startedAt + 10_000 }), 10_000);
  eq(effectiveElapsed({ startedAt, pausedTotal: 0, pausedAt: startedAt + 10_000, at: startedAt + 70_000 }), 10_000);
  eq(effectiveElapsed({ startedAt, pausedTotal: 60_000, pausedAt: null, at: startedAt + 75_000 }), 15_000);
  eq(effectiveElapsed({ startedAt, pausedTotal: 60_000, pausedAt: startedAt + 100_000, at: startedAt + 120_000 }), 40_000);
});

check('采样档位包含 1 秒', () => {
  eq(INTERVALS[0], 1000);
  ok(INTERVALS.includes(2000) && INTERVALS.includes(20000));
});

check('token 显示：单位随量级自动切换（k → M）', () => {
  eq(formatTokens(0), '0');
  eq(formatTokens(420), '420');
  eq(formatTokens(999), '999');
  eq(formatTokens(1200), '1.2k');
  eq(formatTokens(2000), '2k');
  eq(formatTokens(45678), '45.7k');
  eq(formatTokens(99_800), '99.8k');
  eq(formatTokens(123_400), '123k');
  eq(formatTokens(1_230_000), '1.23M');
  eq(formatTokens(2_000_000), '2M');
});

check('时长格式化与档位常量', () => {
  eq(formatDuration(0), '0:00');
  eq(formatDuration(65_000), '1:05');
  eq(formatDuration(3_600_000), '60:00');
  eq(INTERVALS.join(','), '1000,2000,5000,10000,20000');
  eq(TOKEN_WARNINGS.join(','), '50000,150000,300000');
});

if (failures.length > 0) {
  console.error(`✗ watch ${failures.length} 项失败：`);
  for (const failure of failures) console.error('  - ' + failure);
  process.exitCode = 1;
} else {
  console.log(`✓ watch ${passed} 项全过`);
}
