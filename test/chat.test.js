/**
 * 轻量讨论的消息拼装：纯函数，不调模型。
 *
 *   node test/chat.test.js
 *
 * @module dsh-companion-journal/test/chat
 */

import { buildMessages, imageSources } from '../lib/chat.js';

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

const base = {
  id: 'r1',
  app: 'Word',
  title: '论文',
  text: '',
  thumb: 'thumbs/a.png',
  answer: '第二段把 AFVRP 归为只看距离，审稿人可能会挑。',
  thread: [],
};

check('首条消息带图（always）', () => {
  const messages = buildMessages(base, { reuseImage: 'always' });
  eq(messages[0].role, 'user');
  ok(messages[0].content.some((b) => b.type === 'image'), '应包含 image 块');
  ok(messages[0].content[0].text.includes('Word「论文」'), '应说明抓的是哪个窗口');
  ok(messages[0].content[0].text.includes('当时它给的评语'), '评语应在首条消息里');
  eq(messages.length, 1, '没有讨论时只有首条消息');
});

check('纯文字模式不带图；选中文字时描述用文本', () => {
  const messages = buildMessages({ ...base, text: '这是选中的一段' }, { reuseImage: 'never' });
  ok(!messages[0].content.some((b) => b.type === 'image'), '不该有 image 块');
  ok(messages[0].content[0].text.includes('这是选中的一段'), '应包含选中的文字');
});

check('first 模式：已有讨论后不再带图（省视觉 token）', () => {
  const withThread = { ...base, thread: [{ role: 'user', text: '为什么？' }, { role: 'assistant', text: '因为…' }] };
  ok(!buildMessages(withThread, { reuseImage: 'first' })[0].content.some((b) => b.type === 'image'));
  ok(buildMessages(base, { reuseImage: 'first' })[0].content.some((b) => b.type === 'image'));
});

check('讨论线程逐条追加，首条前缀保持不变（缓存命中的前提）', () => {
  const withThread = { ...base, thread: [{ role: 'user', text: '为什么？' }, { role: 'assistant', text: '因为…' }] };
  const messages = buildMessages(withThread, { reuseImage: 'always' });
  eq(messages.length, 3, '首条 + 两轮讨论');
  eq(messages[1].content[0].text, '我：为什么？');
  eq(messages[2].content[0].text, '它：因为…');
  // 前缀稳定性：首条消息不包含讨论内容
  ok(!messages[0].content[0].text.includes('为什么？'), '首条消息不应随讨论变化');
});

check('没有 thumb 时不放 image 块', () => {
  const messages = buildMessages({ ...base, thumb: '' }, { reuseImage: 'always' });
  ok(!messages[0].content.some((b) => b.type === 'image'));
});

// 回归：多画面记录没有 record.thumb，早期 buildMessages 只在 thumb 存在时放图，
// 于是「追问」静默退化成纯文字——模型只看到当时的评语，回答自然对不上。

check('多画面记录：每张都占位，且带 OCR 文字', () => {
  const images = Array.from({ length: 11 }, (_, i) => ({ thumb: `thumbs/p${i}.webp`, image: `images/p${i}.jpg` }));
  const record = { ...base, thumb: '', image: '', images, ocr: '哔哩哔哩首页 · 推荐：AI 工具 / 影之刃零' };
  eq(imageSources(record).length, 9, '最多带 9 张');
  const messages = buildMessages(record, { reuseImage: 'always' });
  eq(messages[0].content.filter((b) => b.type === 'image').length, 9, '应有 9 个图片占位');
  const text = messages[0].content[0].text;
  ok(text.includes('一共 11 张'), '应说明总张数与只带了前几张');
  ok(messages[0].content.some((b) => b.type === 'text' && b.text.includes('画面文字（本地 OCR')), '应带 OCR 文字');
});

check('多画面但只有一张：也能带图（不再是纯文字）', () => {
  const record = { ...base, thumb: '', image: '', images: [{ thumb: 'thumbs/only.webp', image: 'images/only.jpg' }] };
  const messages = buildMessages(record, { reuseImage: 'always' });
  eq(messages[0].content.filter((b) => b.type === 'image').length, 1);
});

check('纯文字记录（没有图）不会被塞 image 块', () => {
  const record = { ...base, thumb: '', image: '', images: [] };
  const messages = buildMessages(record, { reuseImage: 'always' });
  eq(messages[0].content.filter((b) => b.type === 'image').length, 0);
});

if (failures.length > 0) {
  console.error(`✗ chat ${failures.length} 项失败：`);
  for (const failure of failures) console.error('  - ' + failure);
  process.exitCode = 1;
} else {
  console.log(`✓ chat ${passed} 项全过`);
}
