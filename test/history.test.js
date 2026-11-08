/**
 * 陪伴记录的存取与清理：纯文件操作，不碰系统。
 *
 *   node test/history.test.js
 *
 * @module dsh-companion-journal/test/history
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHistory } from '../lib/history.js';

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
  if (actual !== expected) throw new Error(`${label} 期望 ${expected}，实际 ${actual}`);
}

function ok(value, label = '') {
  if (!value) throw new Error(`${label} 期望为真`);
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-history-'));
const config = { history: { path: join(dir, 'history.jsonl'), keepImages: 'full', maxThumbWidth: 360, retentionDays: 90 } };
const history = createHistory(config, { info() {}, warn() {} });

check('追加与读取：坏行不影响整体', () => {
  const a = history.append({ at: '2026-11-05T10:00:00Z', app: 'Word', title: '论文', answer: '第一段有问题' });
  ok(a.id, '应生成 id');
  history.append({ at: '2026-11-05T11:00:00Z', app: 'Zotero', question: '这段讲什么', answer: '灌溉调度' });
  const file = config.history.path;
  const raw = readFileSync(file, 'utf8');
  writeFileSync(file, `${raw}{ not json }\n`);
  const all = history.list({ limit: 10 });
  eq(all.total, 2, '坏行应被跳过');
  eq(all.items[0].app, 'Zotero', '应按时间倒序');
});

check('查询：关键词命中问题与回答', () => {
  eq(history.list({ q: '灌溉' }).total, 1);
  eq(history.list({ q: '论文' }).total, 1);
  eq(history.list({ app: 'Word' }).total, 1);
  eq(history.list({ q: '不存在的东西' }).total, 0);
});

check('范围：日期边界按本地时区切分，不混进昨天', () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'dsh-history-range-'));
  const cfg2 = { history: { path: join(dir2, 'history.jsonl'), keepImages: 'full', maxThumbWidth: 360, retentionDays: 90 } };
  const store = createHistory(cfg2, { info() {}, warn() {} });

  // 本地「昨天 23:30」和「今天 00:30」各一条。东八区下，昨天 23:30 对应 UTC 15:30，
  // 若用 UTC 日期切片，「今天」会把昨天这条算进来（真实 bug）。
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const yesterdayLate = new Date(todayStart.getTime() - 30 * 60 * 1000);
  const todayEarly = new Date(todayStart.getTime() + 30 * 60 * 1000);

  store.append({ at: yesterdayLate.toISOString(), app: 'Word', answer: '昨天的' });
  store.append({ at: todayEarly.toISOString(), app: 'Word', answer: '今天的' });

  // 面板现在传完整时间戳（本地 0 点起算）
  const todayRange = {
    from: todayStart.toISOString(),
    to: new Date(todayStart.getTime() + 86_400_000 - 1).toISOString(),
  };
  const todayItems = store.list({ ...todayRange, limit: 50 }).items;
  eq(todayItems.length, 1, '今天只该有 1 条');
  eq(todayItems[0].answer, '今天的');

  // 兼容旧协议：只传日期字符串时，也应按本地当天解释
  const dayString = `${todayStart.getFullYear()}-${String(todayStart.getMonth() + 1).padStart(2, '0')}-${String(todayStart.getDate()).padStart(2, '0')}`;
  const legacyItems = store.list({ from: dayString, to: dayString, limit: 50 }).items;
  eq(legacyItems.length, 1, '日期字符串也应只命中今天');
  eq(legacyItems[0].answer, '今天的');

  rmSync(dir2, { recursive: true, force: true });
});

check('清理：只删图时保留文字与问答', () => {
  const file = config.history.path;
  const raw = readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim() !== '' && l.startsWith('{'));
  const first = JSON.parse(lines[0]);
  first.thumb = 'thumbs/fake.png';
  first.image = 'images/fake.jpg';
  const rest = lines.slice(1).filter((l) => l.trim() !== '');
  writeFileSync(file, [JSON.stringify(first), ...rest].join('\n') + '\n');

  const before = history.list({ limit: 10 }).total;
  const result = history.cleanup({ from: '2026-11-01', to: '2026-11-30', mode: 'images' });
  eq(result.ok, true);
  eq(result.removed, 0, '只删图不应删记录');
  eq(history.list({ limit: 10 }).total, before, '记录数量不变');
  const record = history.list({ limit: 10 }).items.find((r) => r.app === 'Word');
  eq(record.thumb, '', 'thumb 应被置空');
  eq(record.image, '', 'image 应被置空');
});

check('清理：删除全部时必须指定范围（防误删）', () => {
  const refused = history.cleanup({ mode: 'all' });
  eq(refused.ok, false);
  ok(String(refused.reason).includes('日期'));
});

check('清理：范围外的不受影响', () => {
  const before = history.list({ limit: 10 }).total;
  const result = history.cleanup({ from: '2020-01-01', to: '2020-01-02', mode: 'all' });
  eq(result.ok, true);
  eq(result.removed, 0);
  eq(history.list({ limit: 10 }).total, before);
});

check('按 id 批量删除：只删选中的，其余保留', () => {
  const all = history.list({ limit: 50 }).items;
  const target = all[0];
  const before = all.length;
  const result = history.deleteRecords([target.id]);
  eq(result.ok, true);
  eq(result.removed, 1);
  eq(history.list({ limit: 50 }).total, before - 1);
  eq(history.get(target.id), null, '被删的记录应读不到');
});

check('按 id 删除：空集合不动数据', () => {
  const before = history.list({ limit: 50 }).total;
  const result = history.deleteRecords([]);
  eq(result.removed, 0);
  eq(history.list({ limit: 50 }).total, before);
});

check('容量格式化：小于 1GB 用 MB，达到 1GB 用 GB', () => {
  eq(history.formatBytes(0), '0.0 MB');
  eq(history.formatBytes(5 * 1024 * 1024), '5.0 MB');
  eq(history.formatBytes(1024 ** 3), '1.00 GB');
  eq(history.formatBytes(2.5 * 1024 ** 3), '2.50 GB');
});

check('范围容量：只统计范围内记录', () => {
  const total = history.rangeBytes({});
  const miss = history.rangeBytes({ from: '2020-01-01', to: '2020-01-02' });
  eq(miss, 0, '范围外应为 0');
  ok(total >= miss, '全量不小于范围');
});

check('磁盘用量可读', () => {
  ok(history.diskUsage() > 0);
});

rmSync(dir, { recursive: true, force: true });

// 回归：多画面记录的图片在 images[] 里，早期版本只统计/删除 record.thumb / record.image，
// 结果「全部」远大于「当前范围」，而且删记录后文件留在盘上。

check('多画面记录：容量计入 images[]，删除时也会删掉文件', () => {
  const images = join(dir, 'images');
  const thumbs = join(dir, 'thumbs');
  mkdirSync(images, { recursive: true });
  mkdirSync(thumbs, { recursive: true });
  writeFileSync(join(images, 'm1.jpg'), Buffer.alloc(1200));
  writeFileSync(join(thumbs, 'm1.webp'), Buffer.alloc(120));
  writeFileSync(join(images, 'm2.jpg'), Buffer.alloc(2400));
  writeFileSync(join(thumbs, 'm2.webp'), Buffer.alloc(120));

  const record = history.append({
    kind: 'multi',
    at: '2026-11-06T10:00:00Z',
    images: [
      { thumb: 'thumbs/m1.webp', image: 'images/m1.jpg' },
      { thumb: 'thumbs/m2.webp', image: 'images/m2.jpg' },
    ],
    answer: '两张画面',
  });
  ok(history.bytesOf(record) >= 3840, `容量应含多画面的每一张，实际 ${history.bytesOf(record)}`);
  ok(history.rangeBytes({}) >= 3840, '范围容量也要含多画面');

  history.deleteRecords([record.id]);
  ok(!existsSync(join(images, 'm1.jpg')), '删除记录应删掉 images[0].image');
  ok(!existsSync(join(thumbs, 'm2.webp')), '删除记录应删掉 images[1].thumb');
});

check('清理孤儿：没有记录引用的图片文件会被删掉', () => {
  mkdirSync(join(dir, 'images'), { recursive: true });
  writeFileSync(join(dir, 'images', 'orphan.jpg'), Buffer.alloc(500));
  const result = history.sweepOrphans();
  ok(result.removed >= 1, '应至少删掉一个孤儿');
  ok(!existsSync(join(dir, 'images', 'orphan.jpg')), '孤儿文件应被删除');
});

check('看一阵记录：时间线与统计能存能读', () => {
  const record = history.append({
    kind: 'watch',
    at: '2026-11-08T10:00:00Z',
    app: 'Safari',
    title: '文档',
    answer: '总结。'.repeat(900),
    ocr: '合并的 OCR 文本',
    timeline: [
      { start: 0, end: 30_000, summary: '第一段', chars: 120, needsVisual: false, frames: [{ t: 0, text: '第一帧' }] },
      { start: 30_000, end: 60_000, summary: '第二段', chars: 8, needsVisual: true, frames: [] },
    ],
    stats: { durationMs: 60_000, windows: 2, frames: 5, sheets: 0, estTokens: 1200, intervalMs: 2000, needsVisualWindows: 1, stopReason: 'user' },
  });
  eq(record.kind, 'watch');
  ok(record.answer.length > 2000, '看一阵总结不该被截到 2000 字');
  const list = history.list({ limit: 5 });
  const found = list.items.find((one) => one.id === record.id);
  ok(found, '应能读回');
  eq(found.timeline.length, 2);
  eq(found.timeline[1].needsVisual, true);
  eq(found.stats.windows, 2);
  // 搜索要能命中时间段摘要
  const hit = history.list({ q: '第二段', limit: 5 });
  ok(hit.items.some((one) => one.id === record.id), '时间线摘要应可被搜索');
  history.deleteRecords([record.id]);
});

if (failures.length > 0) {
  console.error(`✗ history ${failures.length} 项失败：`);
  for (const failure of failures) console.error('  - ' + failure);
  process.exitCode = 1;
} else {
  console.log(`✓ history ${passed} 项全过`);
}
