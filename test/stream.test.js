/**
 * 「看一眼」的模型调用：推理吃光 token 时要自动放大预算重试一次。
 *
 *   node test/stream.test.js
 *
 * 背景（用户实测报的）：推理也算进 maxTokens，预算 1200 时模型偶尔把
 * 额度全花在思考上，正文一个字都没有——钱花了、信息没有，只剩一条报错。
 *
 * @module dsh-companion-journal/test/stream
 */

import { describeCollection, streamText } from '../lib/look.js';

let passed = 0;
const failures = [];

/** 注意 check 支持 async：这些用例要 await 流式调用，不 await 会漏掉失败。 */
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

function eq(actual, expected, label = '') {
  if (actual !== expected) throw new Error(`${label} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/** 造一个假的 llm：按脚本依次产出 chunk，并记录每次调用的 maxTokens。 */
function fakeLlm(script) {
  const budgets = [];
  return {
    budgets,
    async *stream(request) {
      budgets.push(request.maxTokens);
      for (const chunk of script[budgets.length - 1] ?? []) yield chunk;
    },
  };
}

const base = { provider: 'p', model: 'm', system: 's', messages: [] };

await check('推理吃光预算时自动翻倍重试并拿到正文', async () => {
  const llm = fakeLlm([
    [{ type: 'reasoning-delta', text: '想想想' }, { type: 'finish', reason: { kind: 'length' } }],
    [{ type: 'text-delta', text: '这是正文' }, { type: 'finish', reason: { kind: 'stop' } }],
  ]);
  const result = await streamText({ ...base, llm, maxTokens: 1200 });
  eq(result.ok, true, '应成功');
  eq(result.text, '这是正文');
  eq(llm.budgets.join(','), '1200,2400', '重试时预算应翻倍');
});

await check('重试预算封顶 16000', async () => {
  const llm = fakeLlm([
    [{ type: 'reasoning-delta' }],
    [{ type: 'reasoning-delta' }],
  ]);
  const result = await streamText({ ...base, llm, maxTokens: 12000 });
  eq(llm.budgets.join(','), '12000,16000', '不要超过 16000');
  eq(result.ok, false, '两次都空应失败');
});

await check('两次都空时给出可读原因', async () => {
  const llm = fakeLlm([
    [{ type: 'reasoning-delta' }],
    [{ type: 'reasoning-delta' }],
  ]);
  const result = await streamText({ ...base, llm, maxTokens: 1000 });
  eq(result.ok, false);
  ok(result.reason.includes('推理吃光了 token'), result.reason);
  eq(llm.budgets.length, 2, '应尝试两次');
});

await check('没有推理、也没有正文时不重试（省一次调用）', async () => {
  const llm = fakeLlm([[{ type: 'finish', reason: { kind: 'stop' } }]]);
  const result = await streamText({ ...base, llm, maxTokens: 1000 });
  eq(result.ok, false);
  eq(llm.budgets.length, 1, '不该重试');
});

await check('模型报错时原样带出原因，不重试', async () => {
  const llm = fakeLlm([[{ type: 'finish', reason: { kind: 'error', failure: { message: '额度不足' } } }]]);
  const result = await streamText({ ...base, llm, maxTokens: 1000 });
  eq(result.ok, false);
  eq(result.reason, '额度不足');
  eq(llm.budgets.length, 1);
});

// ── 多画面分析整条链路的冒烟测试 ─────────────────────────────────────────────
// 回归 2026-11-07 的宿主崩溃：describePage 里引用了不存在的 logger，
// 抛 ReferenceError → 未捕获 → DSH 直接退出。这里用假 ctx 把整条链路跑一遍。

function fakeCtx(reply = '一眼看到的内容') {
  return {
    get(name) {
      if (name === 'llm') {
        return {
          resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
          async *stream() {
            yield { type: 'text-delta', text: reply };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      if (name === 'attachments') return { saveImages: async () => [{ attachment: { id: 'a' } }] };
      return undefined;
    },
  };
}

const item = (n) => ({ text: `第 ${n} 张的 OCR`, bytes: new Uint8Array([1, 2, 3]) });

await check('多画面（单页）能跑完整条链路，不抛异常', async () => {
  const result = await describeCollection({ ctx: fakeCtx(), items: [item(1)], logger: null });
  eq(result.ok, true);
  eq(result.text, '一眼看到的内容');
});

await check('多画面（两页）会做 map-reduce，合成分支也能跑', async () => {
  const items = Array.from({ length: 10 }, (_, i) => item(i + 1));
  const result = await describeCollection({ ctx: fakeCtx(), items, logger: null });
  eq(result.ok, true);
  eq(result.text, '一眼看到的内容');
});

if (failures.length > 0) {
  console.error(`✗ stream ${failures.length} 项失败（通过 ${passed} 项）：`);
  for (const failure of failures) console.error('  - ' + failure);
  process.exitCode = 1;
} else {
  console.log(`✓ stream ${passed} 项全过`);
}
