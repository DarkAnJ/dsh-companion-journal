/**
 * 记录上的「轻量讨论」：带着这条抓取继续追问，但**不是 agent**——没有工具，
 * 只有一个模型和一段我们自己拼的消息历史。
 *
 * 三个必须说清的机制：
 *   1. 模型没有跨调用记忆。所谓「它记得那张图」= 每次请求都把图重新放进消息里。
 *   2. 所以图放在**不变的前缀**里（首条用户消息），让 prompt cache 去摊薄重复成本；
 *      `reuseImage: 'first'` 可以只在首轮带图，之后靠文字描述。
 *   3. 每轮把 `usage` 带回来（含 cacheReadTokens），面板上能看见这轮花了多少。
 *
 * @module dsh-companion-journal/lib/chat
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { buildChatSystem } from './prompt.js';

/** 一条记录里可以带给模型的图片（相对路径，按原始顺序）。上限 9 张，和一次分页一致。 */
export function imageSources(record) {
  const list = [];
  if (Array.isArray(record?.images) && record.images.length > 0) {
    for (const one of record.images) {
      const rel = one?.thumb || one?.image;
      if (rel) list.push(rel);
    }
  } else {
    const rel = record?.thumb || record?.image;
    if (rel) list.push(rel);
  }
  return list.slice(0, PAGE_IMAGE_LIMIT);
}

const PAGE_IMAGE_LIMIT = 9;

/**
 * 拼消息历史（纯函数，便于测试）。
 * @param {object} record 历史记录
 * @param {{reuseImage?: 'always'|'first'|'never'}} [options]
 * @returns {Array<{role:string, content:Array}>}
 */
export function buildMessages(record, { reuseImage = 'always' } = {}) {
  const where = record.title ? `${record.app}「${record.title}」` : record.app || '某个窗口';
  const captured = record.text
    ? `用户选中的一段文字（来自 ${where}）：\n\n${record.text}`
    : `用户在 ${where} 上按了一次「看一眼」。`;
  const first = {
    role: 'user',
    content: [{ type: 'text', text: captured }],
  };
  const thread = Array.isArray(record.thread) ? record.thread : [];
  // first：只在还没有任何讨论时带图（省掉后续每轮的视觉 token）
  const withImage = reuseImage === 'always' || (reuseImage === 'first' && thread.length === 0);
  const sources = imageSources(record);
  if (withImage) {
    // 多画面记录：每张都放一个占位，askAbout 再逐张换成真附件。
    for (const _ of sources) first.content.push({ type: 'image', attachment: null });
    const declared = Array.isArray(record.images) ? record.images.length : 0;
    if (declared > sources.length) {
      first.content[0].text += `\n\n（这条记录一共 ${declared} 张画面，这里只带了前 ${sources.length} 张。）`;
    }
  }
  // 多画面时图多、细节多，OCR 文字比图更省 token，也更适合回答「内容是什么」这类问题。
  const ocr = String(record.ocr ?? '').trim();
  if (ocr !== '') {
    first.content.push({ type: 'text', text: `画面文字（本地 OCR，可能有个别错字）：\n${ocr.slice(0, 6000)}` });
  }

  const messages = [first];
  // 关键：前缀必须**稳定**，缓存才命中。
  // 所以首条消息只放「抓取内容 + 当时的评语 + 图」，不再把讨论折进去；
  // 每一轮讨论各占一条 user 消息追加在后面。之前把所有讨论拼进首条，
  // 每轮前缀都变，cacheRead 只有 20% 左右。
  if (record.answer) {
    first.content[0].text += `\n\n当时它给的评语：${record.answer}`;
  }
  for (const turn of thread) {
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: `${turn.role === 'assistant' ? '它' : '我'}：${turn.text}` }],
    });
  }
  return messages;
}

/** 摘出 usage 里我们关心的几个数。 */
function summarizeUsage(chunk, acc) {
  if (chunk?.type !== 'usage') return;
  const usage = chunk.usage ?? {};
  acc.input = Number(usage.inputTokens ?? acc.input);
  acc.output = Number(usage.outputTokens ?? acc.output);
  acc.cacheRead = Number(usage.cacheReadTokens ?? acc.cacheRead);
}

/**
 * 问一次。返回答案与用量，失败给可读原因（不抛）。
 *
 * @returns {Promise<{ok:true, answer:string, usage:object}|{ok:false, reason:string}>}
 */
export async function askAbout({ ctx, config, record, question, logger }) {
  const llm = ctx?.get?.('llm');
  if (!llm || typeof llm.stream !== 'function') return { ok: false, reason: '宿主没有模型服务' };

  const selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? {};
  // 注意：配置默认值是空字符串，`??` 不会回落到默认选择，必须用 `||`。
  const provider = String(config?.historyChat?.model?.provider || selection.provider || '');
  const model = String(config?.historyChat?.model?.model || selection.model || '');
  if (!provider || !model) return { ok: false, reason: '拿不到可用模型' };

  // 推理也算进 maxTokens：先按模型声明取最低档，再把预算放大，避免正文被思考吃光。
  let effort;
  let modelMax = 0;
  try {
    const info = await llm.resolveModelInfo(provider, model);
    modelMax = Number(info?.defaultMaxTokens) > 0 ? Number(info.defaultMaxTokens) : 0;
    const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts.map((e) => String(e?.id ?? '')) : [];
    effort = ['minimal', 'low', 'none'].find((want) => efforts.includes(want));
  } catch {
    effort = undefined;
  }

  const messages = buildMessages(record, { reuseImage: config?.historyChat?.reuseImage ?? 'always' });

  // 把首条消息里的图片占位换成真附件：多画面记录每张都可能要带（见 imageSources）。
  const imageBlocks = messages[0].content.filter((block) => block?.type === 'image');
  if (imageBlocks.length > 0) {
    const sources = imageSources(record);
    const baseDir = dirname(config.history.path.replace(/^~/, process.env.HOME ?? ''));
    const attachments = ctx?.get?.('attachments');
    const mediaTypeOf = (rel) => {
      const ext = String(rel ?? '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
      return ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
    };
    for (const [index, block] of imageBlocks.entries()) {
      const rel = sources[index];
      try {
        if (!rel) throw new Error('没有对应的图片路径');
        if (!attachments || typeof attachments.saveImages !== 'function') throw new Error('宿主没有附件服务');
        const bytes = await readFile(join(baseDir, rel));
        const refs = await attachments.saveImages([
          { data: new Uint8Array(bytes), mediaType: mediaTypeOf(rel), name: `record-${index}.${rel.split('.').pop()}` },
        ]);
        const ref = Array.isArray(refs) ? refs[0] : refs;
        block.attachment = ref ?? null;
        if (!block.attachment) throw new Error('附件服务没有返回引用');
      } catch (error) {
        logger?.warn?.(`[dsh-companion-journal] 讨论时第 ${index + 1} 张图带不上，跳过：${String(error?.message ?? error)}`);
      }
    }
    // 逐张剔除失败的那些：一张失败不该让其余图也丢掉。
    const okBlocks = imageBlocks.filter((block) => block.attachment);
    if (okBlocks.length !== imageBlocks.length) {
      messages[0].content = messages[0].content.filter((block) => block?.type !== 'image' || block.attachment);
      if (okBlocks.length === 0) {
        messages[0].content[0].text += '\n\n（这次没能把画面图带上来，只能依据上面的文字与评语回答。）';
      }
    }
  }

  messages.push({ role: 'user', content: [{ type: 'text', text: question }] });

  const parts = [];
  const usage = { input: 0, output: 0, cacheRead: 0 };
  let truncated = false;
  const configured = Number(config?.historyChat?.maxTokens) > 0 ? Number(config.historyChat.maxTokens) : 8000;
  // 不能超过模型声明的最大输出，否则适配器会直接拒绝这次调用。
  const ceiling = modelMax > 0 ? modelMax : 16000;
  let budget = Math.min(configured, ceiling);
  let answer = '';
  let reasoning = 0;
  // 预算被思考吃光时翻倍重试一次：否则钱花了、一个字都没有。
  for (let attempt = 0; attempt < 2 && !answer; attempt += 1) {
    parts.length = 0;
    usage.input = 0;
    usage.output = 0;
    usage.cacheRead = 0;
    reasoning = 0;
    try {
      for await (const chunk of llm.stream({
        provider,
        model,
        system: buildChatSystem(),
        messages,
        maxTokens: budget,
        ...(effort ? { reasoningEffort: effort } : {}),
      })) {
        if (chunk?.type === 'text-delta') parts.push(String(chunk.text ?? ''));
        else if (chunk?.type === 'reasoning-delta') reasoning += 1;
        else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && parts.length === 0) {
          parts.push(String(chunk.block.text ?? ''));
        } else if (chunk?.type === 'usage') summarizeUsage(chunk, usage);
        else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
          return { ok: false, reason: String(chunk.reason.failure?.message ?? '模型调用失败') };
        }
      }
    } catch (error) {
      return { ok: false, reason: `模型调用失败：${String(error?.message ?? error)}` };
    }
    answer = parts.join('').trim();
    if (!answer && reasoning > 0 && budget < ceiling) {
      logger?.info?.(`[dsh-companion-journal] 追问没有正文（推理块 ${reasoning}），预算 ${budget} → ${Math.min(budget * 2, ceiling)} 重试`);
      budget = Math.min(budget * 2, ceiling);
    }
  }

  if (!answer) {
    return {
      ok: false,
      reason: reasoning > 0 ? '模型没有给出正文：推理吃光了 token（已自动放大预算重试一次）' : '模型没有给出正文',
    };
  }
  if (truncated) answer += '\n\n……（回答被截断：输出额度用完了，可继续追问或调大 historyChat.maxTokens）';
  return { ok: true, answer, usage, truncated };
}
