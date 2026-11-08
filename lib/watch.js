/**
 * 「看一阵」：锁定一个窗口（或一块屏），持续采样 → 本地切段 → 文本优先分析 → 一条时间线记录。
 *
 * 三条硬约束（都是踩过坑换来的）：
 *   1. **目标锁死**：触发时确定窗口 id / 屏幕；中途切走、被遮挡都不换目标。
 *   2. **文本优先**：每个窗口先只把 OCR 文本交给模型；文字说不清（或模型自己标记
 *      `[需要画面]`）才升级出图。默认不出图。
 *   3. **不设硬上限**：只在记录里记账 + 到阈值时给提示，停不停由用户决定。
 *
 * 这一版先做「采集 / 切段 / 文本摘要 / 时间线记录」；拼图（按变化密度分格）是下一版，
 * 现在遇到需要画面的窗口会标 `needsVisual: true` 并如实写进记录。
 *
 * @module dsh-companion-journal/lib/watch
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { captureScreen, ocrImage, pngSize, runProcess } from './native.js';
import { streamText } from './look.js';
import { renderSheet, salienceOf } from './sheet.js';
import { buildLookSystem } from './prompt.js';

/** 采样间隔可选项（毫秒）。 */
export const INTERVALS = [1000, 2000, 5000, 10000, 20000];
/** 变速启动：前几个窗口短一点，先给用户一句反馈，再稳定到 30 秒。 */
const WINDOW_RAMP = [10_000, 15_000, 30_000];
const WINDOW_DEFAULT = 30_000;
/**
 * 一次送给模型的最多张数（分析用的批上限）。
 *
 * 9 是历史值：最早多画面按 3×3 九宫格分页（PAGE_SIZE = 9）。它**不是**推导出来的，
 * 只是一个成本/清晰度的折中；它约束的是「一次请求发几张」，不是「一段里留几帧」。
 */
/** 发图片的上限（模型一次最多看这么多张）。 */
const ANALYSIS_FRAME_CAP = 9;
/** 纯文字路径可以读更多帧：不发图，多 OCR 几帧只是便宜的文字 token。 */
const TEXT_FRAME_CAP = 12;
/** 分桶权重：1 = 静止段的基础份额，3 = 变化密集区额外倍率（加权时间，不是纯按信息量）。 */
const SALIENCE_WEIGHT = 3;
/** 每段最多留存几帧：按段长推导，保证锚点 + 变化帧都有位置。 */
const RETENTION_CAP = 24;
/** 缩略帧尺寸：128×72。64×36 太粗，一个字的差别会落到子像素里。 */
const THUMB_W = 128;
const THUMB_H = 72;
/**
 * 判变阈值有两层：
 *   - 绝对下限：低于它一定不算变（静态画面实测 0.0003）；
 *   - 自适应：会话内最近若干帧差值的**中位数 × 3**——视频/游戏本身就抖，
 *     全局固定阈值只能二选一：要么漏掉文档里的细小改动，要么把噪声全留下。
 */
const ABS_FLOOR_MEAN = 0.002;
const BASELINE_K = 3;
const BASELINE_WINDOW = 20;
/** 变化像素占比下限：与均值判断取「或」。 */
const CHANGE_RATIO = 0.01;
/** 单块平均差超过它 → 局部有变化（打字、数字变化这类）。 */
const BLOCK_CHANGE = 0.06;
/** 单像素三通道合计超过它才算「变了」。 */
const PIXEL_DELTA = 36;
/**
 * 锚点帧间隔：画面完全不变时，也保证每 60 秒留一张。
 *
 * 这是「采样间隔」和「留存策略」的分界：采样率决定我们多久看一次，
 * 留存决定哪些帧值得作为证据留下。纯靠判变做留存的话，一页 PPT 看 10 分钟
 * 只会留 1 帧——时间线上出现 10 分钟的空洞，追问「第 5 分钟在讲什么」时无从回答。
 */
const ANCHOR_MS = 60_000;
/** 一个窗口里 OCR 少于这么多字符，判定为「文字说不清」。 */
const TEXT_MIN_CHARS = 40;
/**
 * 画面判定：什么时候必须看画面（而不是只看 OCR 文字）。
 *
 * - 文字太少 → 只能看图；
 * - 模型自己标了 `[需要画面]` → 看图；
 * - **高动态画面**（视频/游戏）：文字可能只是弹幕、比分板，但画面本身才是内容 → 看图，
 *   但按 `SHEET_COOLDOWN_MS` 节流，避免每段都付一张图的成本。
 */
const MOTION_BLOCK = 0.1;
/**
 * 高动态度还要看「面积」：字幕换一行能到块差 0.2，但只占 2% 像素。
 * 只看块差会让网课/讲座每 60 秒白出一张拼图（文字明明够用）。面积 ≥5% 才是真的换页/切镜头。
 */
const MOTION_RATIO = 0.05;
const SHEET_COOLDOWN_MS = 60_000;

/**
 * 这一段到底要不要看画面（纯函数）。
 *
 * @param {object} args
 * @param {'auto'|'always'|'off'} args.mode
 * @param {number} args.chars OCR 文字长度
 * @param {boolean} args.modelAsk 模型是否标了 `[需要画面]`
 * @param {number} args.maxBlock 段内最大的局部块差
 * @param {number} args.sinceLastSheetMs 距上一张拼图的毫秒数
 * @param {number} [args.cooldownMs]
 * @returns {'' | 'text-empty' | 'model-flag' | 'always' | 'motion'}
 */
/** 窗口像素尺寸是否变了（拖窗口大小 = 一次真实的内容变化）。 */
export function windowSizeChanged(prev, next) {
  if (!prev || !next) return false;
  return Number(prev.width) !== Number(next.width) || Number(prev.height) !== Number(next.height);
}

export function visualReasonFor({
  mode = 'auto',
  chars = 0,
  modelAsk = false,
  maxBlock = 0,
  maxRatio = 0,
  sinceLastSheetMs = Infinity,
  cooldownMs = SHEET_COOLDOWN_MS,
}) {
  if (mode === 'off') return '';
  if (chars < TEXT_MIN_CHARS) return 'text-empty';
  if (modelAsk) return 'model-flag';
  if (mode === 'always') return 'always';
  if (
    Number(maxBlock) >= MOTION_BLOCK &&
    Number(maxRatio) >= MOTION_RATIO &&
    Number(sinceLastSheetMs) >= cooldownMs
  ) {
    return 'motion';
  }
  return '';
}

/** 预算预警阈值（估算 token）。 */
export const TOKEN_WARNINGS = [50_000, 150_000, 300_000];

/** 读 BMP（sips 输出的 32 位、自上而下）并转成 RGB 数组。 */
export function parseBmp(buffer) {
  if (buffer.length < 54 || buffer[0] !== 0x42 || buffer[1] !== 0x4d) return null;
  const offset = buffer.readUInt32LE(10);
  const width = buffer.readInt32LE(18);
  const rawHeight = buffer.readInt32LE(22);
  const bits = buffer.readUInt16LE(28);
  if (bits !== 32 || width <= 0) return null;
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const pixels = new Uint8Array(width * height * 3);
  const stride = width * 4;
  for (let y = 0; y < height; y += 1) {
    const row = offset + (topDown ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x += 1) {
      const at = row + x * 4;
      const out = (y * width + x) * 3;
      // BMP 是 BGRA
      pixels[out] = buffer[at + 2];
      pixels[out + 1] = buffer[at + 1];
      pixels[out + 2] = buffer[at];
    }
  }
  return { width, height, pixels };
}

/** 两帧的平均绝对差（0–1）。尺寸不一致时按较小区域比。 */
export function meanDiff(a, b) {
  if (!a || !b) return 1;
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  if (width === 0 || height === 0) return 1;
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const ia = (y * a.width + x) * 3;
      const ib = (y * b.width + x) * 3;
      sum += Math.abs(a.pixels[ia] - b.pixels[ib]);
      sum += Math.abs(a.pixels[ia + 1] - b.pixels[ib + 1]);
      sum += Math.abs(a.pixels[ia + 2] - b.pixels[ib + 2]);
      count += 3;
    }
  }
  return count === 0 ? 1 : sum / (count * 255);
}

/**
 * 两帧之间「变化像素」的占比。
 *
 * 只用均值的话，一个播放器窗口里 90% 是静态边框/标题，视频在动也只有 1.8% 的均值差，
 * 会被误判成「没变」——实测踩过。
 */
export function changedRatio(a, b, delta = PIXEL_DELTA) {
  if (!a || !b) return 1;
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  if (width === 0 || height === 0) return 1;
  let changed = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const ia = (y * a.width + x) * 3;
      const ib = (y * b.width + x) * 3;
      const d =
        Math.abs(a.pixels[ia] - b.pixels[ib]) +
        Math.abs(a.pixels[ia + 1] - b.pixels[ib + 1]) +
        Math.abs(a.pixels[ia + 2] - b.pixels[ib + 2]);
      if (d > delta) changed += 1;
    }
  }
  return changed / (width * height);
}

/** 给一个 promise 加超时：超时返回 {ok:false}，不抛。 */
export function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), ms);
      timer?.unref?.();
    }),
  ]);
}

/** 一组数的中位数（空数组返回 0）。 */
/**
 * 把这一段 OCR 文字里**已经出现过的行**剔掉（纯函数）。
 *
 * 连续录制时，界面上的标题、播放量、频道名每段都能识别到，但它们是同一个东西；
 * 全量喂给模型就会「每段都重新介绍一遍」。只留新增行，模型自然只讲变化。
 *
 * @param {string} text 这一段的合并文字
 * @param {Set<string>} seen 之前段里出现过的行
 * @returns {{fresh: string, repeated: number}}
 */
export function freshLines(text, seen) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const fresh = [];
  let repeated = 0;
  for (const line of lines) {
    if (seen?.has(line)) {
      repeated += 1;
      continue;
    }
    fresh.push(line);
  }
  return { fresh: fresh.join('\n'), repeated };
}

export function median(values) {
  const list = (Array.isArray(values) ? values : []).filter((one) => Number.isFinite(one)).slice().sort((a, b) => a - b);
  if (list.length === 0) return 0;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 === 0 ? (list[mid - 1] + list[mid]) / 2 : list[mid];
}

/**
 * 留存决策（纯函数）。
 *
 * keep 有两种：
 *   - change：画面确实变了 → 证据；
 *   - anchor：画面没变，但距上一张已超过 anchorMs → 时间锚点，保证时间线不断档。
 *
 * @param {object} args
 * @param {number} args.diff 与上一张保留帧的平均差
 * @param {number} args.ratio 变化像素占比
 * @param {number[]} args.recent 最近若干次采样的 diff（自适应基线）
 * @param {number} args.sinceLastMs 距上一张保留帧的毫秒数
 * @param {number} [args.anchorMs]
 */
export function decideRetention({ diff, ratio, block = 0, recent = [], sinceLastMs = Infinity, anchorMs = ANCHOR_MS }) {
  const baseline = median(recent);
  const meanFloor = Math.max(ABS_FLOOR_MEAN, baseline * BASELINE_K);
  // 三路取或：整帧均值（大面积变化）、变化像素占比（中等面积）、局部块（小范围改动）。
  const changed = Number(diff) >= meanFloor || Number(ratio) >= CHANGE_RATIO || Number(block) >= BLOCK_CHANGE;
  if (changed) return { keep: true, kind: 'change', meanFloor, baseline };
  if (sinceLastMs >= anchorMs) return { keep: true, kind: 'anchor', meanFloor, baseline };
  return { keep: false, kind: 'skip', meanFloor, baseline };
}

/**
 * 局部变化：把画面切成 `grid×grid` 块，取「单块平均差」的最大值。
 *
 * 为什么需要：打字、改一个数字这种变化，占整帧不到 1%，全局均值/占比都看不出，
 * 但落在某个块里是明显的。三路信号取「或」，才不会漏掉这类内容变化。
 */
export function maxBlockDiff(a, b, grid = 8) {
  if (!a || !b) return 1;
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  if (width === 0 || height === 0) return 1;
  let best = 0;
  const bw = width / grid;
  const bh = height / grid;
  for (let gy = 0; gy < grid; gy += 1) {
    for (let gx = 0; gx < grid; gx += 1) {
      let sum = 0;
      let count = 0;
      const x0 = Math.floor(gx * bw);
      const x1 = Math.max(x0 + 1, Math.floor((gx + 1) * bw));
      const y0 = Math.floor(gy * bh);
      const y1 = Math.max(y0 + 1, Math.floor((gy + 1) * bh));
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const ia = (y * a.width + x) * 3;
          const ib = (y * b.width + x) * 3;
          sum += Math.abs(a.pixels[ia] - b.pixels[ib]);
          sum += Math.abs(a.pixels[ia + 1] - b.pixels[ib + 1]);
          sum += Math.abs(a.pixels[ia + 2] - b.pixels[ib + 2]);
          count += 3;
        }
      }
      if (count > 0) best = Math.max(best, sum / (count * 255));
    }
  }
  return best;
}

/** 这一帧算不算「画面变了」（不含锚点判断，给测试用）。 */
export function shouldKeep(prev, next) {
  if (!prev) return true;
  return meanDiff(prev, next) >= ABS_FLOOR_MEAN || changedRatio(prev, next) >= CHANGE_RATIO;
}

/**
 * 从窗口里的候选帧里挑出最多 `cap` 帧（纯函数，便于测试）。
 *
 * 先按「与上一张保留帧的差异」去重，再保证时间覆盖：按时间均匀分桶，每桶取差异最大的一帧。
 * 静态画面少留几帧是正常的。
 *
 * @param {Array<{t:number, diff:number}>} frames 已按时间排序
 */
export function pickFrames(frames, cap = ANALYSIS_FRAME_CAP) {
  const list = frames.filter((one) => one && one.kept !== false).sort((a, b) => a.t - b.t);
  if (list.length <= cap) return list;
  // 1) 手动记录的帧永远保留（用户主动说「这一帧重要」），其次是锚点（时间覆盖凭证）。
  const manual = list.filter((one) => one.kind === 'manual');
  const anchors = list.filter((one) => one.kind === 'anchor');
  const picked = [...manual.slice(0, cap), ...anchors.slice(0, cap)];
  const slots = cap - picked.length;
  if (slots <= 0) return picked.slice(0, cap).sort((a, b) => a.t - b.t);
  // 2) 剩下名额分桶：**桶宽按「时间 × 信息量」加权**，不是纯等分时间。
  //
  //    纯等分时间的问题：一段里 80% 时间画面没动、20% 时间狂变，
  //    等分桶会把名额浪费在静止段。纯按信息量分桶又会把静止段彻底丢掉（时间线出现空洞）。
  //    加权时间（权重 = 1 + k×信息量）是折中：静止段仍占一份基本宽度，变化密集处拿到更多桶。
  const rest = list.filter((one) => one.kind !== 'anchor' && one.kind !== 'manual');
  const weights = rest.map((frame) => 1 + SALIENCE_WEIGHT * salienceOf(frame));
  const total = weights.reduce((sum, one) => sum + one, 0) || 1;
  const buckets = new Map();
  let accumulated = 0;
  rest.forEach((frame, index) => {
    const before = accumulated;
    accumulated += weights[index];
    const slot = Math.min(slots - 1, Math.max(0, Math.floor((before / total) * slots)));
    const best = buckets.get(slot);
    // 桶内挑「信息量」最高的：字幕、改数字这类局部变化能被选出来，只有 mean 高的大滚动不行。
    if (!best || salienceOf(frame) > salienceOf(best)) buckets.set(slot, frame);
  });
  picked.push(...[...buckets.values()]);
  // 加权分桶可能空出几个桶（变化集中在某几处）：用剩下的帧按信息量补齐，
  // 否则「9 个名额」只用掉 8 个，白白浪费一次发送额度。
  if (picked.length < cap) {
    const used = new Set(picked);
    const spare = rest.filter((frame) => !used.has(frame)).sort((a, b) => salienceOf(b) - salienceOf(a));
    picked.push(...spare.slice(0, cap - picked.length));
  }
  return picked.slice(0, cap).sort((a, b) => a.t - b.t);
}

/** 估算 token：文字按字符数，图片按 1.5k/张；只是记账用，不承诺精确。 */
export function estimateTokens({ chars = 0, sheets = 0 } = {}) {
  return Math.round(Number(chars) / 2 + Number(sheets) * 1500);
}

/** 录制目录的父目录：从 history.path 推，但必须先展开 `~`。 */
function baseDirOf(config) {
  const raw = String(config?.history?.path ?? '').replace(/^~(?=$|\/)/, process.env.HOME ?? '~');
  const dir = raw.replace(/\/[^/]+$/, '');
  return dir === '' ? '/tmp/dsh-companion-journal' : dir;
}

/** 分位数（0–1），空数组返回 0。 */
export function percentile(values, q) {
  const list = (Array.isArray(values) ? values : []).filter((one) => Number.isFinite(one)).slice().sort((a, b) => a - b);
  if (list.length === 0) return 0;
  const index = Math.min(list.length - 1, Math.max(0, Math.floor((list.length - 1) * q)));
  return list[index];
}

/**
 * token 的显示写法：数值小就给原数，大了自动换单位（k → M），不让它变成一串难读的数字。
 *
 * 1000 以下：原数；10 万以下：一位小数 k；一百万以下：k（去掉 .0）；以上：M（两位小数）。
 *
 * @param {number} value
 */
export function formatTokens(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 995_000) return `${Math.round(n / 1000)}k`;
  const m = n / 1_000_000;
  return `${m.toFixed(2).replace(/\.?0+$/, '')}M`;
}

/**
 * 有效录制时长（纯函数）：暂停期间不计时。
 *
 * @param {object} args
 * @param {number} args.startedAt 开始时刻（毫秒时间戳）
 * @param {number} [args.pausedTotal] 已累计的暂停时长
 * @param {number|null} [args.pausedAt] 当前这次暂停的开始时刻（没暂停传 null）
 * @param {number} args.at 当前时刻
 */
export function effectiveElapsed({ startedAt, pausedTotal = 0, pausedAt = null, at }) {
  const paused = (pausedTotal ?? 0) + (pausedAt ? at - pausedAt : 0);
  return Math.max(0, at - startedAt - paused);
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
}

/** 给模型看的时间戳：`00:32`。 */
function clock(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * 建一个录制会话控制器。
 *
 * @param {object} args
 * @param {object} args.ctx 宿主上下文（取 llm / attachments / subprocess）
 * @param {object} args.config 插件配置
 * @param {object} [args.history] 记录存储
 * @param {Function} [args.logger]
 * @param {Function} [args.onStatus] 状态变化回调（宿主用它更新气泡）
 * @param {Function} [args.onFinish] 结束时回调（记录 id、文本、统计）
 */
export function createWatch({ ctx, config, history = null, logger = console, onStatus = null, onFinish = null }) {
  /** @type {null | object} */
  let session = null;
  let timer = null;
  /** OCR 并发上限：每路一个子进程，开太多会互相拖慢（实测 2 路最稳）。 */
  const OCR_CONCURRENCY = 2;
  let ocrActive = 0;
  const ocrQueue = [];

  /**
   * 给一帧排队做 OCR，**不等它完成**。
   *
   * 段结束时才统一 OCR 的话，用户会看到「停止后先卡几秒」；提前在采样间隙里跑，
   * 段结束时大多数帧已经识别完，只是把结果取回来。总成本不变，等待时间被摊平。
   */
  function queueOcr(frame) {
    frame.ocrReady = new Promise((resolve) => {
      const run = async () => {
        ocrActive += 1;
        try {
          const bytes = await readFile(frame.path);
          const ocr = await ocrImage(ctx, bytes);
          frame.text = String(ocr.text ?? '').slice(0, 4000);
        } catch (error) {
          logger?.warn?.(`[dsh-companion-journal] 看一阵：预取 OCR 失败 ${String(error?.message ?? error)}`);
        } finally {
          ocrActive -= 1;
          // 已识别但还没结算进段里的字数：气泡上的花费要能实时涨，不能等段结束才跳。
          if (session && frame.text) session.pendingChars = (session.pendingChars ?? 0) + frame.text.length;
          resolve();
          const next = ocrQueue.shift();
          if (next) void next();
        }
      };
      if (ocrActive < OCR_CONCURRENCY) void run();
      else ocrQueue.push(run);
    });
  }

  /**
   * 控制条的心跳：每 1 秒刷一次状态。
   *
   * 没有它的话，采样率切到 5s/10s/20s 后气泡只在「抓到一帧」时才更新，
   * 计时会一次停 5–20 秒——看起来就像录制被暂停了（用户实测反馈）。
   */
  let statusTimer = null;

  const now = () => Date.now();
  const emit = (phase = 'tick') => {
    try {
      onStatus?.({ ...status(), phase });
    } catch {
      /* 气泡更新失败不影响录制 */
    }
  };

  function status() {
    if (!session) return { active: false };
    const elapsed = activeElapsed();
    const chars = session.windows.reduce((n, w) => n + w.chars, 0) + session.pendingChars;
    return {
      active: true,
      paused: session.paused,
      stopping: session.stopping === true,
      elapsedMs: elapsed,
      intervalMs: session.intervalMs,
      windows: session.windows.length,
      frames: session.keptFrames,
      estTokens: estimateTokens({ chars, sheets: session.sheets }),
      // 已经为这些段花掉的钱：文字 + 拼图（estimateTokens 已经折算过）
      manual: Number(session.manualFrames ?? 0),
      // 最近一段的模型输出：宿主用它渲染控制条上方的「段输出」气泡。
      segment: String(session.windows[session.windows.length - 1]?.summary ?? ''),
      segmentIndex: session.windows.length,
      target: session.target,
    };
  }

  function startStatusClock() {
    if (statusTimer) return;
    statusTimer = setInterval(() => {
      if (session && !session.paused) emit('heartbeat');
    }, 1000);
    statusTimer?.unref?.();
  }

  function stopStatusClock() {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  }

  /**
   * 「有效录制时长」：**暂停的时间不算**。
   *
   * 之前直接用 now - startedAt，暂停 2 分钟再继续，时间会突然跳 2 分钟，
   * 段的边界、锚点、统计全跟着偏。现在把暂停时长扣掉。
   */
  function activeElapsed() {
    if (!session) return 0;
    return effectiveElapsed({
      startedAt: session.startedAt,
      pausedTotal: session.pausedTotal ?? 0,
      pausedAt: session.pausedAt,
      at: now(),
    });
  }

  function windowMs(index) {
    return WINDOW_RAMP[index] ?? WINDOW_DEFAULT;
  }

  /** 截一帧 → 缩小成 64×36 的 BMP → 与上一张保留帧比较。 */
  async function grab() {
    if (!session || session.grabbing) return;
    session.grabbing = true;
    try {
      await grabOnce();
    } finally {
      if (session) session.grabbing = false;
    }
  }

  async function grabOnce() {
    if (!session) return;
    const { bytes } = await captureScreen(ctx, {
      ...(session.target.kind === 'window' ? { windowId: session.target.windowId } : { region: session.target.region }),
    });
    const dir = session.dir;
    const stamp = now();
    const raw = join(dir, `f-${stamp}.png`);
    const small = join(dir, `f-${stamp}.bmp`);
    writeFileSync(raw, bytes);
    // 窗口被改变大小时，像素尺寸会变。记下来：尺寸变化本身是一次「内容变了」，
    // 也要写进记录，否则回放时看不出当时窗口被拖过。
    const size = pngSize(bytes);
    const changedSize = windowSizeChanged(session.lastWindowSize, size);
    if (size) session.lastWindowSize = size;
    if (changedSize) session.resizes += 1;

    // 缩略帧**保持比例**再补黑边到 128×72：直接 -z 会拉伸，窗口一变比例，
    // 同一份内容在缩略帧里被压扁的方式就变了，判变信号会多出一次假变化。
    //
    // 注意：sips 的 --padToHeightWidth 会忽略 -s format bmp（实测仍输出 PNG），
    // 所以分两步：先缩放+补边成 PNG，再转 BMP。
    const padded = join(dir, `f-${stamp}-pad.png`);
    const padResult = await runProcess(
      ctx,
      [
        '/usr/bin/sips',
        '-Z', String(THUMB_W),
        '--padToHeightWidth', String(THUMB_H), String(THUMB_W),
        '--padColor', '000000',
        '-s', 'format', 'png',
        raw,
        '--out', padded,
      ],
      { timeoutMs: 10000 },
    );
    if (padResult.code !== 0) throw new Error(`sips 缩放失败：${padResult.stderr.trim().slice(0, 120)}`);
    const resized = await runProcess(
      ctx,
      ['/usr/bin/sips', '-s', 'format', 'bmp', padded, '--out', small],
      { timeoutMs: 10000 },
    );
    await unlink(padded).catch(() => {});
    if (resized.code !== 0) throw new Error(`sips 转 BMP 失败：${resized.stderr.trim().slice(0, 120)}`);
    const parsed = parseBmp(await readFile(small));
    await unlink(small).catch(() => {});
    if (!parsed) throw new Error('缩略帧解析失败');

    const t = activeElapsed();
    const diff = session.lastSmall ? meanDiff(session.lastSmall, parsed) : 1;
    const ratio = session.lastSmall ? changedRatio(session.lastSmall, parsed) : 1;
    const block = session.lastSmall ? maxBlockDiff(session.lastSmall, parsed) : 1;
    const sinceLastMs = session.lastKeptAt === null ? Infinity : t - session.lastKeptAt;
    const manual = session.forceManual === true;
    session.forceManual = false;
    const forceKeep = session.retention === 'interval';
    const decision = manual
      ? { keep: true, kind: 'manual' }
      : changedSize
      ? { keep: true, kind: 'change' }
      : forceKeep
      ? { keep: true, kind: session.lastSmall ? 'change' : 'anchor' }
      : decideRetention({
      diff,
      ratio,
      block,
      recent: session.recentDiffs,
      sinceLastMs,
      anchorMs: session.anchorMs,
    });

    // 自适应基线的样本：只记「相邻两次采样」的差，用于估计这个窗口的固有抖动。
    // 第一帧没有「上一帧」可比，diff 是 1（哨兵值）。它不该进基线/直方图，否则阈值被带偏。
    const hadPrev = Boolean(session.lastSmall);
    if (hadPrev) {
      session.metrics.diff.push(diff);
      session.metrics.ratio.push(ratio);
      session.metrics.block.push(block);
    }
    for (const key of ['diff', 'ratio', 'block']) {
      if (session.metrics[key].length > 300) session.metrics[key].shift();
    }
    if (hadPrev) {
      session.recentDiffs.push(diff);
      if (session.recentDiffs.length > BASELINE_WINDOW) session.recentDiffs.shift();
    }

    if (!decision.keep) {
      session.skipped += 1;
      await unlink(raw).catch(() => {});
      return;
    }
    session.lastSmall = parsed;
    session.lastKeptAt = t;
    session.keptFrames += 1;
    if (decision.kind === 'anchor') session.anchorFrames += 1;
    if (decision.kind === 'manual') session.manualFrames = (session.manualFrames ?? 0) + 1;
    const frame = { t, path: raw, diff, ratio, block, kind: decision.kind, layoutChanged: changedSize, size };
    session.current.frames.push(frame);
    // 只给「可能被选中送模型」的前 9 帧预取 OCR：
    // 段一长（比如 90 秒）一帧帧都 OCR 是纯浪费——最终只发 9 帧，剩下的识别结果没人用。
    // 超出 9 帧的部分，如果结算时被选中，finishWindow 会现场补 OCR。
    if (session.current.frames.length <= TEXT_FRAME_CAP) queueOcr(frame);
    // 留存上限与「发送上限」无关：这里只防极端情况（超高刷新率画面）把磁盘撑爆。
    if (session.current.frames.length > RETENTION_CAP) {
      const victim = session.current.frames
        .filter((one) => one.kind === 'change')
        .sort((a, b) => a.block - b.block)[0];
      if (victim) {
        session.current.frames = session.current.frames.filter((one) => one !== victim);
        await unlink(victim.path).catch(() => {});
        session.skipped += 1;
      }
    }
  }

  /** 收一个窗口：挑帧 → OCR → 文本摘要（必要时标记需要画面）。 */
  async function finishWindow() {
    if (!session || session.current.frames.length === 0) return;
    // 文字路径用更大的帧预算；拼图仍只取 9 帧（发图上限）。
    const frames = pickFrames(session.current.frames, TEXT_FRAME_CAP);
    const texts = [];
    for (const frame of frames) {
      try {
        if (frame.ocrReady) await frame.ocrReady;
        if (frame.text === undefined) {
          const bytes = await readFile(frame.path);
          const ocr = await ocrImage(ctx, bytes);
          frame.text = String(ocr.text ?? '').slice(0, 4000);
        }
        if (frame.text) texts.push(frame.text);
      } catch (error) {
        logger?.warn?.(`[dsh-companion-journal] 看一阵：这一帧 OCR 失败 ${String(error?.message ?? error)}`);
      }
    }
    const merged = [...new Set(texts.join('\n').split('\n').map((line) => line.trim()).filter(Boolean))]
      .join('\n')
      .slice(0, 4000);
    // 段的边界按标称窗口推进：结束时间 = 起点 + 该窗长度（再截到当前时刻，避免报未来的时间）。
    const elapsed = activeElapsed();
    const plannedEnd = session.current.start + windowMs(session.windows.length);
    const win = {
      start: session.current.start,
      end: Math.min(elapsed, plannedEnd),
      frames: frames.map((f) => ({ t: f.t, text: f.text ? f.text.slice(0, 1200) : '' })),
      text: merged,
      chars: merged.length,
      needsVisual: false,
      summary: '',
    };
    const requested = ['auto', 'always', 'off'].includes(String(config?.watch?.visual ?? 'auto'))
      ? String(config?.watch?.visual ?? 'auto')
      : 'auto';
    let modelAsk = false;
    if (win.textForModel === '') {
      // 没有新行：不花这次调用。如果画面在动，下面会按「需要画面」补一张拼图。
      win.summary = merged === '' ? '（这一段没有识别到文字）' : '（这一段没有新的文字变化）';
    } else if (merged.length >= TEXT_MIN_CHARS || fresh.length >= TEXT_MIN_CHARS) {
      win.summary = await summarizeWindow({ win, target: session.target });
      modelAsk = /\$?\[需要画面\]/.test(win.summary);
    } else {
      win.summary = fresh === '' ? '（这一段没有识别到文字）' : fresh.slice(0, 200);
    }
    // 高动态画面（视频/游戏）：文字可能只是弹幕/比分板，画面才是内容本身。
    // 增量文字：只把这一段的**新行**交给模型；没有新行就不必再问一次（省一次调用）。
    const { fresh, repeated } = freshLines(merged, session.seenLines);
    for (const line of merged.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) session.seenLines.add(trimmed);
    }
    win.repeatedLines = repeated;
    win.textForModel = fresh.length >= 20 ? fresh : '';
    const maxBlock = frames.reduce((max, frame) => Math.max(max, Number(frame.block ?? 0)), 0);
    const maxRatio = frames.reduce((max, frame) => Math.max(max, Number(frame.ratio ?? 0)), 0);
    const reason = visualReasonFor({
      mode: requested,
      chars: merged.length,
      modelAsk,
      maxRatio,
      maxBlock,
      sinceLastSheetMs: elapsed - (session.lastSheetAt ?? -Infinity),
    });
    win.needsVisual = reason !== '';
    win.visualReason = reason;
    if (win.needsVisual && !session?.stopping) {
      await upgradeWithSheet(win);
      session.lastSheetAt = elapsed;
    }
    session.windows.push(win);
    session.pendingChars = 0;
    // 只保留这一窗挑中的帧，其余立刻删掉（磁盘不涨）
    const keep = new Set(frames.map((f) => f.path));
    for (const frame of session.current.frames) {
      if (!keep.has(frame.path)) await unlink(frame.path).catch(() => {});
    }
    session.current = { start: plannedEnd, frames: [] };
    emit('window');
  }

  /**
   * 把「文字说不清」的一段升级成看图：拼一张图，带着它再问一次。
   *
   * 只对 needsVisual 的段做一次；失败就保留纯文字结论，不重试（避免花双份钱）。
   */
  async function upgradeWithSheet(win) {
    if (!session) return win;
    const frames = pickFrames(session.current?.frames ?? [], ANALYSIS_FRAME_CAP);
    const usable = (win.frames ?? []).length > 0 ? frames : [];
    if (usable.length === 0) return win;
    try {
      const sheetDir = join(baseDirOf(config), 'sheets');
      mkdirSync(sheetDir, { recursive: true });
      const sheetName = `w-${session.id}-${Math.round(win.start / 1000)}.png`;
      const out = join(sheetDir, sheetName);
      const rendered = await renderSheet(ctx, { frames: usable, out });
      if (!rendered.ok) {
        logger?.warn?.(`[dsh-companion-journal] 看一阵：拼图失败 ${rendered.reason}`);
        return win;
      }
      const attachments = ctx?.get?.('attachments');
      const { readFile: read } = await import('node:fs/promises');
      const bytes = await read(out);
      const refs = await attachments.saveImages([{ data: new Uint8Array(bytes), mediaType: 'image/png', name: 'sheet.png' }]);
      const ref = Array.isArray(refs) ? refs[0] : refs;
      if (!ref) return win;
      const llm = ctx?.get?.('llm');
      const selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? {};
      const provider = String(selection.provider ?? '');
      const model = String(selection.model ?? '');
      if (!llm || !provider || !model) return win;
      const result = await withTimeout(
        streamText({
        llm,
        provider,
        model,
        system: buildLookSystem({ length: config?.look?.length ?? 'normal' }),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  `这是「看一阵」里的第 ${session.windows.length + 1} 段（${Math.round((win.end - win.start) / 1000)} 秒）。` +
                  `下面这张是这段的画面拼图，按时间顺序排列，格子越大表示那段画面越稳定。\n\n` +
                  `这段的文字层几乎没有内容，请结合画面说两三句话：这一段在发生什么、有什么值得注意的。`,
              },
              { type: 'image', attachment: ref },
            ],
          },
        ],
        maxTokens: 3000,
        logger,
      }),
        45_000,
      );
      if (result.ok && result.text) {
        win.summary = result.text;
        win.sheetsUsed = true;
        session.sheets += 1;
        win.sheet = `sheets/${sheetName}`;
        session.sheetFiles.push(out);
      }
    } catch (error) {
      logger?.warn?.(`[dsh-companion-journal] 看一阵：升级看图失败 ${String(error?.message ?? error)}`);
    }
    return win;
  }

  async function summarizeWindow({ win, target }) {
    try {
      const llm = ctx?.get?.('llm');
      const selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? {};
      const provider = String(selection.provider ?? '');
      const model = String(selection.model ?? '');
      if (!llm || !provider || !model) return '（没有可用的模型）';
      const system = buildLookSystem({ length: config?.look?.length ?? 'normal' });
      // 连续录制：把前面两段的结论带进来，并明确要求「只写增量」。
      // 不带上下文的话每段都是独立的一次提问，模型会把播放量、标题这类没变的东西反复说一遍（用户实测）。
      const previous = session.windows.slice(-2).map((w, i) => {
        const index = session.windows.length - Math.min(2, session.windows.length) + i + 1;
        return `第 ${index} 段：${String(w.summary ?? '').slice(0, 200)}`;
      });
      const context = previous.length > 0 ? `前面已经看过的内容：\n${previous.join('\n')}\n\n` : '';
      const messages = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `我正在看一阵（连续录制中）：${target.app || '某个窗口'}${target.title ? `「${target.title}」` : ''}。\n` +
                `${context}` +
                `下面是第 ${session.windows.length + 1} 段（${Math.round(windowMs(session.windows.length) / 1000)} 秒）里**新出现**的文字：\n\n` +
                `${win.textForModel ?? win.text}\n\n` +
                '请用两三句话说明这一段发生了什么变化、有什么值得注意的。\n' +
                '规则：\n' +
                '1. 只写这一段的增量；前面已经说过的事（标题、播放量、频道名这类没变的信息）不要再重复；\n' +
                '2. 如果这段没有新内容，就直说「这段没有新变化」；\n' +
                '3. 如果仅凭这些文字无法判断（缺关键画面、文字乱码、只有图片），在末尾单独一行写 [需要画面]。',
            },
          ],
        },
      ];
      const result = await streamText({ llm, provider, model, system, messages });
      return result.ok ? result.text : '';
    } catch (error) {
      logger?.warn?.(`[dsh-companion-journal] 看一阵：这一窗摘要失败 ${String(error?.message ?? error)}`);
      return '';
    }
  }


  function schedule() {
    if (!session || session.paused || session.stopping) return;
    const delay = Math.max(0, session.nextAt - now());
    timer = setTimeout(async () => {
      if (!session) return;
      const tickStart = now();
      try {
        const elapsed = activeElapsed();
        if (elapsed - session.current.start >= windowMs(session.windows.length)) {
          if (session.current.frames.length > 0) {
            await finishWindow();
          } else {
            // 这一窗一帧都没留下（画面完全没变）：记一个「空档」，边界照标称长度前进。
            // 不记空档的话，时间线上会出现一段凭空消失的时间（用户看回放会以为是丢了数据）。
            const len = windowMs(session.windows.length);
            session.gaps.push({ start: session.current.start, end: session.current.start + len });
            session.current.start += len;
          }
        }
        await grab();
      } catch (error) {
        const code = String(error?.code ?? '');
        if (code === 'window-gone') {
          logger?.info?.('[dsh-companion-journal] 看一阵：目标窗口已关闭，自动停止');
          await stop({ reason: 'target-gone' });
          return;
        }
        const message = String(error?.message ?? error);
        logger?.warn?.(`[dsh-companion-journal] 看一阵：这一帧失败 ${message}`);
        try {
          if (session && session.errorLines < 5) {
            session.errorLines += 1;
            writeFileSync(join(baseDirOf(config), 'watch-error.log'), `${new Date().toISOString()} ${message}\n`, { flag: 'a' });
          }
        } catch {
          /* 忽略 */
        }
      }
      if (!session) return;
      session.nextAt = tickStart + session.intervalMs;
      emit('tick');
      schedule();
    }, delay);
    timer?.unref?.();
  }

  async function start({ target, intervalMs = INTERVALS[0] } = {}) {
    if (session) return { ok: false, reason: '已经在录制' };
    if (!target || (!target.windowId && !target.region)) return { ok: false, reason: '没有可录制的目标' };
    const base = baseDirOf(config);
    const dir = join(base, 'watch', `s-${Date.now().toString(36)}`);
    // 每次开始录都把诊断文件清空：录了半天 0 帧时，第一现场就在这几行里。
    try {
      writeFileSync(join(base, 'watch-error.log'), `start ${new Date().toISOString()}\n`);
    } catch {
      /* 写不了就算了 */
    }
    mkdirSync(dir, { recursive: true });
    const sessionId = Date.now().toString(36);
    session = {
      id: sessionId,
      sheetFiles: [],
      startedAt: now(),
      nextAt: now(),
      intervalMs: INTERVALS.includes(Number(intervalMs)) ? Number(intervalMs) : INTERVALS[0],
      target: {
        kind: target.windowId ? 'window' : 'screen',
        windowId: Number(target.windowId ?? 0),
        region: target.region ?? null,
        app: String(target.app ?? ''),
        title: String(target.title ?? ''),
      },
      dir,
      windows: [],
      gaps: [],
      seenLines: new Set(),
      current: { start: 0, frames: [] },
      keptFrames: 0,
      anchorFrames: 0,
      skipped: 0,
      lastKeptAt: null,
      lastWindowSize: null,
      resizes: 0,
      recentDiffs: [],
      metrics: { diff: [], ratio: [], block: [] },
      anchorMs: Math.max(ANCHOR_MS, Number(config?.watch?.anchorMs) || 0),
      // retention: smart（按内容判变 + 锚点）/ interval（每次采样都留，受每段 9 帧上限约束）
      retention: String(config?.watch?.retention ?? 'smart') === 'interval' ? 'interval' : 'smart',
      pendingChars: 0,
      sheets: 0,
      errorLines: 0,
      paused: false,
      pausedTotal: 0,
      pausedAt: null,
      stopping: false,
      lastSmall: null,
    };
    emit('start');
    startStatusClock();
    schedule();
    return { ok: true, target: session.target };
  }

  /**
   * 手动记一帧：用户点「记下这一帧」时调用。
   *
   * 不依赖判变结果：哪怕画面和上一帧一模一样，也保留（用户主动标注了「这里重要」）。
   */
  function captureNow() {
    if (!session || session.stopping) return { ok: false, reason: '没有在录制' };
    if (session.grabbing) return { ok: false, reason: '正在抓帧，稍等一下' };
    session.forceManual = true;
    // 立刻抓，不等下一个采样周期：否则切到 10/20 秒档时，点完要等十几秒才有反应，
    // 看起来就是「按钮没用」（用户实测反馈）。
    void grab()
      .catch((error) => logger?.warn?.(`[dsh-companion-journal] 看一阵：手动记帧失败 ${String(error?.message ?? error)}`))
      .finally(() => emit('manual'));
    return { ok: true };
  }

  function pause() {
    if (!session || session.stopping) return { ok: false, reason: '没有在录制' };
    session.paused = true;
    session.pausedAt = now();
    clearTimeout(timer);
    timer = null;
    stopStatusClock();
    emit('pause');
    return { ok: true };
  }

  function resume() {
    if (!session || session.stopping || !session.paused) return { ok: false, reason: '没有暂停' };
    session.paused = false;
    if (session.pausedAt) {
      session.pausedTotal = (session.pausedTotal ?? 0) + (now() - session.pausedAt);
      session.pausedAt = null;
    }
    session.nextAt = now();
    emit('resume');
    startStatusClock();
    schedule();
    return { ok: true };
  }

  /** 设置采样间隔（毫秒），立刻生效：下一拍就按新间隔排。 */
  function setIntervalMs(ms) {
    if (!session || session.stopping) return { ok: false, reason: '没有在录制' };
    const wanted = INTERVALS.includes(Number(ms)) ? Number(ms) : session.intervalMs;
    session.intervalMs = wanted;
    session.nextAt = now() + wanted;
    emit('interval');
    return { ok: true, intervalMs: wanted };
  }

  /** 兼容旧调用：循环切下一档。 */
  function cycleInterval() {
    if (!session || session.stopping) return { ok: false, reason: '没有在录制' };
    const index = INTERVALS.indexOf(session.intervalMs);
    return setIntervalMs(INTERVALS[(index + 1) % INTERVALS.length]);
  }

  async function stop({ reason = 'user' } = {}) {
    if (!session) return { ok: false, reason: '没有在录制' };
    // 幂等：收尾可能要等模型（几秒），这期间再点一次「停止」不该重入——
    // 重入会让第二个调用拿到已经置空的 session，直接读 s.startedAt 崩掉宿主（2026-11-08 实测）。
    if (session.stopPromise) return session.stopPromise;
    const s = session;
    s.stopping = true;
    emit('stopping');
    clearTimeout(timer);
    timer = null;
    stopStatusClock();
    s.stopPromise = (async () => {
      await finishWindow().catch(() => {});
      if (s.dropped) {
        await cleanup(s.dir);
        return { ok: false, reason: 'discarded' };
      }
      let finalText = '';
      try {
        finalText = await synthesize({ windows: s.windows, target: s.target });
      } catch (error) {
        logger?.warn?.(`[dsh-companion-journal] 看一阵：合成失败 ${String(error?.message ?? error)}`);
      }
      const stats = {
        durationMs: now() - s.startedAt - (s.pausedTotal ?? 0) - (s.pausedAt ? now() - s.pausedAt : 0),
        windows: s.windows.length,
        frames: s.keptFrames,
        anchors: s.anchorFrames,
        manual: Number(s.manualFrames ?? 0),
        skipped: s.skipped,
        sheets: s.sheets,
        estTokens: estimateTokens({
          chars: s.windows.reduce((n, w) => n + w.chars, 0),
          sheets: s.sheets,
        }),
        intervalMs: s.intervalMs,
        needsVisualWindows: s.windows.filter((w) => w.needsVisual).length,
      gaps: s.gaps.length,
      resizes: Number(s.resizes ?? 0),
        histogram: {
          diffP50: Number(percentile(s.metrics.diff, 0.5).toFixed(5)),
          diffP90: Number(percentile(s.metrics.diff, 0.9).toFixed(5)),
          diffMax: Number((s.metrics.diff.length ? Math.max(...s.metrics.diff) : 0).toFixed(5)),
          ratioP90: Number(percentile(s.metrics.ratio, 0.9).toFixed(5)),
          blockP90: Number(percentile(s.metrics.block, 0.9).toFixed(5)),
          samples: s.metrics.diff.length,
        },
        stopReason: reason,
      };
      const record = history?.append({
        kind: 'watch',
        mode: 'watch',
        app: s.target.app,
        title: s.target.title,
        answer: finalText.slice(0, 6000),
        ocr: s.windows.map((w) => w.text).join('\n\n').slice(0, 8000),
        timeline: [
          ...s.windows,
          ...s.gaps.map((gap) => ({
            start: gap.start,
            end: gap.end,
            summary: '（这一段画面没有变化，没有留存帧）',
            chars: 0,
            needsVisual: false,
            gap: true,
            frames: [],
          })),
        ]
          .sort((a, b) => a.start - b.start)
          .map((w) => ({
          start: w.start,
          end: w.end,
          summary: w.summary.slice(0, 600),
          visualReason: String(w.visualReason ?? ''),
          chars: w.chars,
          needsVisual: w.needsVisual,
          frames: w.frames.slice(0, TEXT_FRAME_CAP).map((f) => ({ t: f.t, text: f.text.slice(0, 400) })),
          sheet: String(w.sheet ?? ''),
          gap: Boolean(w.gap),
        })),
        // 卡片用第一张拼图当缩略图；点开时走 image 路径看大图，所以两张都指同一个文件。
        thumb: s.windows.find((w) => w.sheet)?.sheet ?? '',
        image: s.windows.find((w) => w.sheet)?.sheet ?? '',
        stats,
        ms: stats.durationMs,
      }) ?? null;
      await cleanup(s.dir);
      try {
        onFinish?.({ record, stats, text: finalText });
      } catch {
        /* 忽略 */
      }
      return { ok: true, record, stats };
    })();
    try {
      return await s.stopPromise;
    } catch (error) {
      logger?.warn?.(`[dsh-companion-journal] 看一阵：收尾失败 ${String(error?.message ?? error)}`);
      return { ok: false, reason: String(error?.message ?? error) };
    } finally {
      if (session === s) session = null;
    }
  }

  async function discard() {
    if (!session) return { ok: false, reason: '没有在录制' };
    clearTimeout(timer);
    timer = null;
    stopStatusClock();
    const s = session;
    if (s.stopping) {
      // 正在收尾：标记丢弃，让 stop 那边跳过写记录。
      s.dropped = true;
      return { ok: true, deferred: true };
    }
    const sheets = [...(s.sheetFiles ?? [])];
    session = null;
    await cleanup(s.dir);
    for (const file of sheets) await unlink(file).catch(() => {});
    return { ok: true };
  }


  async function synthesize({ windows, target }) {
    if (windows.length === 0) return '这一阵没采到内容。';
    if (windows.length === 1) return windows[0].summary;
    const llm = ctx?.get?.('llm');
    const selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? {};
    const provider = String(selection.provider ?? '');
    const model = String(selection.model ?? '');
    if (!llm || !provider || !model) return windows.map((w) => w.summary).filter(Boolean).join('\n');
    const system = buildLookSystem({ length: config?.look?.length ?? 'normal' });
    const body = windows
      .map((w, i) => `【${clock(w.start)}–${clock(w.end)}】${w.summary}${w.needsVisual ? '（这段没看画面）' : ''}`)
      .join('\n\n');
    const result = await streamText({
      llm,
      provider,
      model,
      system,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `我看了一阵：${target.app || '某个窗口'}${target.title ? `「${target.title}」` : ''}，共 ${windows.length} 段。\n\n` +
                `${body}\n\n请用一段话总结这一阵发生了什么、有哪些值得注意的点。不要分点。`,
            },
          ],
        },
      ],
    });
    return result.ok ? result.text : windows.map((w) => w.summary).filter(Boolean).join('\n');
  }

  async function cleanup(dir) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* 已经删了 */
    }
  }

  return { start, pause, resume, stop, discard, cycleInterval, setIntervalMs, captureNow, status, isActive: () => Boolean(session) };
}
