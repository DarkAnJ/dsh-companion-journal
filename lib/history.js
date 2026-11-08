/**
 * 陪伴记录：一眼看过的内容落盘、可查询、可清理。
 *
 * 设计取舍：
 *   - 单文件 append-only JSONL，不做数据库：一天几十条，一年几万条，全量读进内存足够；
 *     真要上规模再换 SQLite，接口语义（q / from / to / app / mode）保持不变。
 *   - 截图只存**缩略图**（默认宽 360、webp），存 `images/` 子目录，记录里存相对路径 ——
 *     这样把整个目录挪到 iCloud 也不会断链。
 *   - 清理支持两种粒度：整条删除，或只删图保留文字与问答。
 *
 * @module dsh-companion-journal/lib/history
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** `~` 展开：配置里允许写 `~/...`。 */
function expandHome(p) {
  const raw = String(p ?? '');
  if (raw === '~') return process.env.HOME ?? raw;
  if (raw.startsWith('~/')) return join(process.env.HOME ?? '', raw.slice(2));
  return raw;
}

/** 生成稳定 id：时间 + 随机后缀（多设备合并时不会撞）。 */
function makeId(now = Date.now()) {
  const iso = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${iso}-${rand}`;
}

export function createHistory(config, logger) {
  const file = resolve(expandHome(config.history.path));
  const dir = dirname(file);
  const imagesDir = join(dir, 'images');       // 原图（JPEG，可压缩但保清晰）
  const thumbsDir = join(dir, 'thumbs');       // 列表用的缩略图
  const keepImages = String(config.history.keepImages ?? 'full');
  const maxThumbWidth = Number(config.history.maxThumbWidth) || 360;

  try {
    mkdirSync(dir, { recursive: true });
    if (keepImages !== 'none') {
      mkdirSync(thumbsDir, { recursive: true });
      if (keepImages === 'full') mkdirSync(imagesDir, { recursive: true });
    }
    if (!existsSync(file)) writeFileSync(file, '');
  } catch (error) {
    logger?.warn?.(`[dsh-companion-journal] 历史目录建不出来：${String(error?.message ?? error)}`);
  }

  /** 读全量记录；坏行跳过，不让一行脏数据毁掉整个面板。 */
  function all() {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const record = JSON.parse(trimmed);
        if (record && typeof record === 'object' && typeof record.at === 'string') out.push(record);
      } catch {
        /* 跳过坏行 */
      }
    }
    return out;
  }

  function writeAll(records) {
    const body = records.map((r) => JSON.stringify(r)).join('\n');
    writeFileSync(file, body === '' ? '' : `${body}\n`);
  }

  /** 追加一条抓取记录，返回落盘后的记录（含 id）。 */
  function append(record) {
    const entry = {
      id: record.id ?? makeId(),
      at: new Date(record.at ?? Date.now()).toISOString(),
      mode: String(record.mode ?? 'f8'),
      // 记录类型：'single'（默认）/ 'multi'（多画面收集）/ 'watch'（看一阵）。
      kind: record.kind === 'multi' ? 'multi' : record.kind === 'watch' ? 'watch' : 'single',
      images: Array.isArray(record.images)
        ? record.images.slice(0, 60).map((item) => ({
            thumb: String(item?.thumb ?? ''),
            image: String(item?.image ?? ''),
            text: String(item?.text ?? '').slice(0, 4000),
          }))
        : [],
      app: String(record.app ?? ''),
      title: String(record.title ?? '').slice(0, 200),
      via: String(record.via ?? ''),
      thumb: record.thumb ? String(record.thumb) : '',
      image: record.image ? String(record.image) : '',
      thread: Array.isArray(record.thread) ? record.thread.slice(-50) : [],
      text: String(record.text ?? '').slice(0, 8000),
      // 画面文字（本地 OCR）：**只用于搜索**，不在面板里当「选中的文字」展示。
      // 与 text 分开是为了保持语义：text = 当时喂给模型的文字（比如选中的一段）。
      ocr: String(record.ocr ?? '').slice(0, 8000),
      question: record.question ? String(record.question).slice(0, 2000) : '',
      // 看一阵的最终总结可能长一点，其它类型保持原来的上限。
      answer: String(record.answer ?? '').slice(0, record.kind === 'watch' ? 8000 : 2000),
      ms: Number(record.ms ?? 0),
      device: String(record.device ?? ''),
      // 诊断字段（不显示在面板，只在接口里可查）：这条记录按什么目标截的。
      targetVia: record.targetVia ? String(record.targetVia) : '',
      targetWindowId: Number(record.targetWindowId ?? 0),
      targetDesktop: Boolean(record.targetDesktop),
      targetRegion: String(record.targetRegion ?? ''),
      // 看一阵：时间线 + 统计。其它记录为空数组/对象，不影响老数据。
      timeline: Array.isArray(record.timeline)
        ? record.timeline.slice(0, 200).map((win) => ({
            start: Number(win?.start ?? 0),
            end: Number(win?.end ?? 0),
            summary: String(win?.summary ?? '').slice(0, 600),
            chars: Number(win?.chars ?? 0),
            needsVisual: Boolean(win?.needsVisual),
            sheet: String(win?.sheet ?? ''),
            visualReason: String(win?.visualReason ?? ''),
            gap: Boolean(win?.gap),
            frames: Array.isArray(win?.frames)
              ? win.frames.slice(0, 9).map((frame) => ({
                  t: Number(frame?.t ?? 0),
                  layoutChanged: Boolean(frame?.layoutChanged),
                  text: String(frame?.text ?? '').slice(0, 400),
                }))
              : [],
          }))
        : [],
      stats: record.stats && typeof record.stats === 'object' ? {
        durationMs: Number(record.stats.durationMs ?? 0),
        windows: Number(record.stats.windows ?? 0),
        frames: Number(record.stats.frames ?? 0),
        sheets: Number(record.stats.sheets ?? 0),
        estTokens: Number(record.stats.estTokens ?? 0),
        anchors: Number(record.stats.anchors ?? 0),
        manual: Number(record.stats.manual ?? 0),
        skipped: Number(record.stats.skipped ?? 0),
        gaps: Number(record.stats.gaps ?? 0),
        resizes: Number(record.stats.resizes ?? 0),
        intervalMs: Number(record.stats.intervalMs ?? 0),
        needsVisualWindows: Number(record.stats.needsVisualWindows ?? 0),
        stopReason: String(record.stats.stopReason ?? ''),
        histogram: record.stats.histogram && typeof record.stats.histogram === 'object' ? {
          diffP50: Number(record.stats.histogram.diffP50 ?? 0),
          diffP90: Number(record.stats.histogram.diffP90 ?? 0),
          diffMax: Number(record.stats.histogram.diffMax ?? 0),
          ratioP90: Number(record.stats.histogram.ratioP90 ?? 0),
          blockP90: Number(record.stats.histogram.blockP90 ?? 0),
          samples: Number(record.stats.histogram.samples ?? 0),
        } : {},
      } : {},
    };
    try {
      appendFileSync(file, `${JSON.stringify(entry)}\n`);
    } catch (error) {
      logger?.warn?.(`[dsh-companion-journal] 写历史失败：${String(error?.message ?? error)}`);
    }
    return entry;
  }

  /** 按 id 更新一条记录（用于追加讨论线程），返回更新后的记录或 null。 */
  function update(id, patch) {
    const records = all();
    const index = records.findIndex((r) => r.id === id);
    if (index < 0) return null;
    const next = { ...records[index], ...patch, id };
    if (Array.isArray(patch?.thread)) next.thread = patch.thread.slice(-50);
    records[index] = next;
    writeAll(records);
    return next;
  }

  /** 读一条记录。 */
  function get(id) {
    return all().find((r) => r.id === id) ?? null;
  }

  /**
   * 把边界的字符串解成时间戳。
   *
   * 关键：只有日期（`2026-11-07`）时按**本地时区**当天 00:00 起算。
   * 之前用 `Date.parse('2026-11-07')`，它按 UTC 解释——在东八区，本地 11/07 凌晨还在
   * UTC 11/06，于是「今天」把昨天的记录也带进来了（实测）。
   */
  function boundTs(value, isEnd) {
    const raw = String(value ?? '');
    if (raw === '') return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const [year, month, day] = raw.split('-').map(Number);
      const start = new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
      return Number.isFinite(start) ? (isEnd ? start + 86_400_000 - 1 : start) : null;
    }
    const ts = Date.parse(raw);
    return Number.isFinite(ts) ? ts : null;
  }

  function inRange(record, from, to) {
    const at = Date.parse(record.at);
    if (!Number.isFinite(at)) return false;
    const fromTs = boundTs(from, false);
    const toTs = boundTs(to, true);
    if (fromTs !== null && at < fromTs) return false;
    if (toTs !== null && at > toTs) return false;
    return true;
  }

  /** 查询：关键词（大小写不敏感，含问题/答案/标题/正文）+ 时间 + 应用 + 模式。 */
  function list({ q = '', from = '', to = '', app = '', mode = '', limit = 200 } = {}) {
    const needle = String(q).trim().toLowerCase();
    const records = all()
      .filter((r) => (from || to ? inRange(r, from, to) : true))
      .filter((r) => (app ? String(r.app).toLowerCase() === String(app).toLowerCase() : true))
      .filter((r) => (mode ? String(r.mode) === String(mode) : true))
      .filter((r) => {
        if (needle === '') return true;
        const timelineText = Array.isArray(r.timeline) ? r.timeline.map((win) => win.summary).join(' ') : '';
        const hay = `${r.app} ${r.title} ${r.text} ${r.ocr} ${r.question} ${r.answer} ${timelineText}`.toLowerCase();
        return hay.includes(needle);
      })
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return { total: records.length, items: records.slice(0, Math.max(1, Math.min(1000, Number(limit) || 200))) };
  }

  /** 聚合：按应用计数，供面板顶部做筛选/概览。 */
  function stats() {
    const records = all();
    const byApp = new Map();
    let withImage = 0;
    for (const r of records) {
      const key = String(r.app || '未知');
      byApp.set(key, (byApp.get(key) ?? 0) + 1);
      if (r.thumb) withImage += 1;
    }
    return {
      total: records.length,
      withImage,
      apps: [...byApp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => ({ name, count })),
    };
  }

  /** 删掉一条记录引用的缩略图与原图（文件不存在也算成功）。 */
  /** 一条记录引用到的所有图片文件（单画面用 thumb/image，多画面在 images[] 里）。 */
  function imageRefsOf(record) {
    const refs = new Set();
    if (record?.thumb) refs.add(record.thumb);
    if (record?.image) refs.add(record.image);
    if (Array.isArray(record?.images)) {
      for (const one of record.images) {
        if (one?.thumb) refs.add(one.thumb);
        if (one?.image) refs.add(one.image);
      }
    }
    return refs;
  }

  function removeImages(record) {
    for (const rel of imageRefsOf(record)) {
      try {
        unlinkSync(join(dir, rel));
      } catch {
        /* 已不存在 */
      }
    }
  }

  /** 一条记录占用的字节数（缩略图 + 原图，含多画面的每一张）。 */
  function bytesOf(record) {
    let total = 0;
    for (const rel of imageRefsOf(record)) {
      try {
        total += statSync(join(dir, rel)).size;
      } catch {
        /* 文件已不存在 */
      }
    }
    return total;
  }

  /** 给定范围内所有记录的图片占用字节数（面板上「当前范围缓存大小」用它）。 */
  function rangeBytes({ from = '', to = '' } = {}) {
    let total = 0;
    for (const record of all()) {
      if (from || to) {
        if (!inRange(record, from, to)) continue;
      }
      total += bytesOf(record);
    }
    return total;
  }

  /** 人类可读的容量：小于 1GB 用 MB，达到 1GB 用 GB。 */
  function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    const gb = value / 1024 ** 3;
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    return `${(value / 1024 ** 2).toFixed(1)} MB`;
  }

  /**
   * 清理。两种粒度：
   *   - mode 'all'：范围内的记录整条删除（含图）
   *   - mode 'images'：保留记录的文字与问答，只删图并把 thumb 置空
   *
   * @returns {{ok:true, removed:number, images:number, kept:number}|{ok:false, reason:string}}
   */
  function cleanup({ from = '', to = '', mode = 'all' } = {}) {
    if (from === '' && to === '') return { ok: false, reason: '请至少指定开始或结束日期（避免误删全部）' };
    const records = all();
    const hits = records.filter((r) => inRange(r, from, to));
    if (hits.length === 0) return { ok: true, removed: 0, images: 0, kept: records.length };

    let images = 0;
    let kept = records;
    if (mode === 'images') {
      for (const r of hits) {
        if (r.thumb || r.image) images += 1;
        removeImages(r);
        r.thumb = '';
        r.image = '';
      }
      kept = records;
    } else {
      for (const r of hits) {
        if (r.thumb || r.image) images += 1;
        removeImages(r);
      }
      const hitIds = new Set(hits.map((r) => r.id));
      kept = records.filter((r) => !hitIds.has(r.id));
    }

    writeAll(kept);
    logger?.info?.(`[dsh-companion-journal] 清理历史：${from || '最早'} → ${to || '今天'}，${hits.length} 条，${images} 张图`);
    return { ok: true, removed: mode === 'images' ? 0 : hits.length, images, kept: kept.length };
  }

  /**
   * 按 id 批量删除记录（含缩略图与原图）。
   * @param {string[]} ids
   */
  function deleteRecords(ids) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)));
    if (wanted.size === 0) return { ok: true, removed: 0, images: 0, kept: all().length };
    const records = all();
    const hits = records.filter((r) => wanted.has(r.id));
    let images = 0;
    for (const r of hits) {
      if (r.thumb || r.image) images += 1;
      removeImages(r);
    }
    const kept = records.filter((r) => !wanted.has(r.id));
    writeAll(kept);
    logger?.info?.(`[dsh-companion-journal] 手动删除 ${hits.length} 条记录（${images} 张图）`);
    return { ok: true, removed: hits.length, images, kept: kept.length };
  }

  /**
   * 清掉「没有任何记录引用」的图片文件。
   *
   * 为什么会有孤儿：早期版本删除记录时只删 record.thumb / record.image，
   * 多画面记录的 images[] 没删——文件留在盘上，面板的「全部」比「当前范围」大一大截。
   * 只在启动时扫一次（一次 readdir，不轮询），删掉才算得准。
   */
  /**
   * 清掉 7 天前的看一阵拼图。
   *
   * 拼图是证据，不是长期资产：一条记录超过清理周期后，图也会被记录清理带走；
   * 这里额外扫一遍目录，防「记录删了但文件还在」的孤儿。
   */
  function sweepSheets({ maxAgeDays = 7 } = {}) {
    const dir = join(dirname(file), 'sheets');
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    let removed = 0;
    try {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        try {
          if (statSync(full).mtimeMs < cutoff) {
            unlinkSync(full);
            removed += 1;
          }
        } catch {
          /* 单个文件失败不影响其它 */
        }
      }
    } catch {
      /* 没有 sheets 目录 */
    }
    return removed;
  }

  function sweepOrphans() {
    const keep = new Set();
    for (const record of all()) {
      for (const rel of imageRefsOf(record)) keep.add(rel);
    }
    let removed = 0;
    let bytes = 0;
    for (const [folder, prefix] of [[imagesDir, 'images'], [thumbsDir, 'thumbs']]) {
      let names = [];
      try {
        names = readdirSync(folder);
      } catch {
        continue;
      }
      for (const name of names) {
        if (keep.has(`${prefix}/${name}`)) continue;
        try {
          bytes += statSync(join(folder, name)).size;
          unlinkSync(join(folder, name));
          removed += 1;
        } catch {
          /* 删不掉就算了，下次启动再看 */
        }
      }
    }
    if (removed > 0) {
      logger?.info?.(`[dsh-companion-journal] 清掉 ${removed} 个没有记录引用的图片文件，释放 ${formatBytes(bytes)}`);
    }
    return { removed, bytes };
  }

  /** 磁盘用量：给面板显示总量，也方便判断要不要清。 */
  function diskUsage() {
    let bytes = 0;
    try {
      bytes += readFileSync(file).length;
    } catch {
      /* 忽略 */
    }
    for (const folder of [imagesDir, thumbsDir]) {
      try {
        for (const name of readdirSync(folder)) {
          try {
            bytes += statSync(join(folder, name)).size;
          } catch {
            /* 忽略 */
          }
        }
      } catch {
        /* 目录不存在 */
      }
    }
    return bytes;
  }

  // 启动时扫一次孤儿文件：一次 readdir，不是轮询。
  try {
    sweepOrphans();
    sweepSheets();
  } catch (error) {
    logger?.warn?.(`[dsh-companion-journal] 清理孤儿图片失败：${String(error?.message ?? error)}`);
  }

  return {
    file,
    imagesDir,
    thumbsDir,
    keepImages,
    rangeBytes,
    bytesOf,
    sweepOrphans,
    sweepSheets,
    formatBytes,
    maxThumbWidth,
    append,
    update,
    get,
    list,
    stats,
    cleanup,
    deleteRecords,
    diskUsage,
    makeId,
  };
}
