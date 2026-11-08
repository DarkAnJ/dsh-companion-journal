/**
 * 种子事件形状：纯函数，不碰 DSH。
 *
 *   node test/seed.test.js
 *
 * @module dsh-companion-journal/test/seed
 */

import { buildSeedEvents, buildSessionSeed, describeRecord, recordImagePaths } from '../lib/seed.js';

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

check('种子：第 0 条是 inherited 标记，第 1 条是 user/message', () => {
  const seed = buildSeedEvents({ text: '你好' });
  eq(seed.length, 2);
  eq(seed[0].type, 'session/end-seed');
  eq(seed[0].seq, 0);
  eq(seed[0].data.inherited, true);
  eq(seed[1].type, 'user/message');
  eq(seed[1].seq, 1);
  eq(seed[1].surfaceOp, 'append');
  ok(seed[1].data.id, '消息必须有 id');
  eq(seed[1].data.content[0].text, '你好');
});

check('种子：带图时内容块里多一个 image', () => {
  const image = { type: 'image', attachment: { attachmentId: 'a1' } };
  const seed = buildSeedEvents({ text: '看图', image });
  eq(seed[1].data.content.length, 2);
  eq(seed[1].data.content[1].type, 'image');
});

check('种子：buildSeedEvents 仍把消息塞进 seed（兼容旧调用）', () => {
  const seed = buildSeedEvents({ text: '你好', title: '讨论：Word' });
  const titleEvent = seed.find((e) => e.type === 'session/title');
  ok(titleEvent, '应包含 session/title');
  eq(titleEvent.data.title, '讨论：Word');
  const msg = seed.find((e) => e.type === 'user/message');
  ok(msg, '兼容模式应包含消息');
  eq(msg.seq, seed.indexOf(msg), 'seq 必须与下标一致');
});

check('会话种子：消息不放进 seed，交给 followup 注入', () => {
  const { seed, message } = buildSessionSeed({ text: '你好', title: '讨论：Word' });
  eq(seed[0].type, 'session/end-seed');
  eq(seed.length, 2, '标记 + 标题');
  eq(seed[1].type, 'session/title');
  eq(seed[1].seq, 1, 'seq 连续');
  ok(!seed.some((e) => e.type === 'user/message'), 'seed 里不应有消息（否则不会产生一轮）');
  eq(message.role, 'user');
  eq(message.content[0].text, '你好');
  ok(message.id, '消息要有 id');
});

check('描述：文字记录用统一版式并包含原文', () => {
  const text = describeRecord({ app: 'WeChat', via: 'selection', text: '今晚一起吃饭吗', at: '2026-11-06T00:45:07Z', answer: '这是一句约饭' });
  ok(text.includes('今晚一起吃饭吗'), '必须包含原文');
  ok(text.includes('来源：WeChat'), '要写清来自哪个应用');
  ok(!text.includes('【看一眼】'), '正文里不该有标签式抬头');
  
  ok(!text.includes('窗口截图'), '文字记录不该标成截图');
});

check('描述：截图记录版式与文字记录一致（只有类型/内容不同）', () => {
  const text = describeRecord({ app: 'Safari', title: 'bilibili', via: 'window', at: '2026-11-06T00:45:07Z', answer: '看到了视频' });
  ok(text.includes('来源：Safari「bilibili」'), text);
  ok(!text.includes('【看一眼】'), text);
  ok(text.includes(' · '), '来源行带时间');
});

check('描述：写清来源与当时的评语', () => {
  const text = describeRecord({ app: 'Word', title: '论文', at: '2026-11-05T14:06:22Z', answer: '第二段有问题' });
  ok(text.includes('Word「论文」'), text);
  ok(text.includes('第二段有问题'), text);
  ok(text.includes('停下等我提问'), '应明确让它看完就停，避免乱调工具');
});

// 回归：多画面记录开新会话时只能带一张图（用户实测）。
check('种子：多张图按顺序全部进内容块', () => {
  const images = [
    { type: 'image', attachment: { attachmentId: 'a1' } },
    { type: 'image', attachment: { attachmentId: 'a2' } },
    { type: 'image', attachment: { attachmentId: 'a3' } },
  ];
  const { message } = buildSessionSeed({ text: '看这组', images, title: '讨论' });
  const imageBlocks = message.content.filter((block) => block.type === 'image');
  eq(imageBlocks.length, 3, '三张图都应放进首条消息');
  eq(imageBlocks[2].attachment.attachmentId, 'a3', '顺序应与记录一致');
});

check('描述里写明这组一共几张', () => {
  const record = {
    app: 'Safari',
    at: '2026-11-06T19:28:58Z',
    answer: '评语',
    images: [{ thumb: 'a' }, { thumb: 'b' }, { thumb: 'c' }],
  };
  const text = describeRecord(record, { attached: 3 });
  ok(text.includes('这组一共 3 张画面'), text);
  ok(text.includes('已附上前 3 张'), text);
  ok(text.includes('概述这组画面'), text);
});

// 回归：看一阵的记录每段各有一张拼图，开新会话时只带了第一张。
check('取图：看一阵按段收集、多画面按 images、单画面退回 image', () => {
  const watch = {
    kind: 'watch',
    thumb: 'sheets/first.png',
    image: 'sheets/first.png',
    timeline: [
      { start: 0, end: 10000, sheet: 'sheets/a.png' },
      { start: 10000, end: 25000, sheet: 'sheets/b.png' },
      { start: 25000, end: 55000, sheet: '' },
      { start: 55000, end: 85000, sheet: 'sheets/c.png' },
    ],
  };
  eq(recordImagePaths(watch).join(','), 'sheets/a.png,sheets/b.png,sheets/c.png');
  eq(recordImagePaths(watch, 2).length, 2);
  const multi = { images: [{ image: 'images/1.jpg', thumb: 'thumbs/1.webp' }, { image: '', thumb: 'thumbs/2.webp' }] };
  eq(recordImagePaths(multi).join(','), 'images/1.jpg,thumbs/2.webp');
  eq(recordImagePaths({ image: 'images/only.jpg' }).join(','), 'images/only.jpg');
  eq(recordImagePaths({}).length, 0);
});

check('描述：看一阵的段数与附图写进首条消息', () => {
  const text = describeRecord({ kind: 'watch', app: 'Safari', timeline: [{}, {}, {}] }, { attached: 3 });
  ok(text.includes('看一阵'), text);
  ok(text.includes('共 3 段'), text);
  ok(text.includes('附上 3 张画面拼图'), text);
});

if (failures.length > 0) {
  console.error(`✗ seed ${failures.length} 项失败：`);
  for (const failure of failures) console.error('  - ' + failure);
  process.exitCode = 1;
} else {
  console.log(`✓ seed ${passed} 项全过`);
}
