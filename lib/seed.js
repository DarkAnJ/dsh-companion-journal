/**
 * 种子会话：把一条历史记录变成一条新 DSH 会话的首条用户消息。
 *
 * 规则全部来自 `dsh-session` 的构造校验（实测踩出来的，改之前先看错误信息）：
 *   1. `seed` 的 seq 必须从 0 连续
 *   2. surface 事件（user/message）必须带 `surfaceOp: 'append'`
 *   3. 消息必须带 `id`
 *   4. `isSeeded` 时，`seed[inheritedEventCount]` 必须是 `session/end-seed`
 *      且 `data.inherited === true`。新会话没有继承内容 → 标记放第 0 条。
 *   5. 调用方还要给 `inheritedEventCount: 0`
 *
 * @module dsh-companion-journal/lib/seed
 */

/** 生成一条可用的消息 id。 */
function messageId() {
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 组装「种子事件 + 首条消息」。
 *
 * 关键：首条消息**不放进种子**，而是交给 `agent.followup()` 注入。
 * 原因：种出来的消息不产生一轮对话，会话投影里 `blank` 仍是 true，
 * 侧边栏不会显示（实测）。用 followup 走真实一轮，会话才「活」。
 *
 * @param {object} args
 * @param {string} args.text 首条用户消息正文
 * @param {object|null} [args.image] 已保存的 image 内容块（单张）
 * @param {Array<object>|null} [args.images] 已保存的多张 image 内容块（多画面记录）
 * @param {string} [args.title] 会话标题
 * @returns {{seed: object[], message: object}}
 */
export function buildSessionSeed({ text, image = null, images = null, title = '', agentPreset = '' }) {
  const now = Date.now();
  const seed = [{ type: 'session/end-seed', seq: 0, time: now, data: { inherited: true } }];
  // 正常会话都有这条；缺了会让会话投影的 agentPreset 为 null，
  // 进而干扰客户端的草稿初始化（实测表现为「新会话总带出旧会话」）。
  if (agentPreset) {
    seed.push({
      type: 'agent-preset/selected',
      seq: seed.length,
      time: now,
      data: { agentPreset: String(agentPreset) },
    });
  }
  if (title) {
    seed.push({
      type: 'session/title',
      seq: seed.length,
      time: now,
      data: { title: String(title).slice(0, 60), messageSeqs: [], source: { kind: 'fallback' } },
    });
  }
  const content = [{ type: 'text', text: String(text ?? '') }];
  if (image) content.push(image);
  // 多画面记录：按顺序把每一张都放进首条消息，否则新会话里只有一张图可看。
  if (Array.isArray(images)) {
    for (const one of images) {
      if (one) content.push(one);
    }
  }
  const message = {
    id: messageId(),
    role: 'user',
    content,
    source: { kind: 'user' },
  };
  return { seed, message };
}

/**
 * 把一条历史记录描述成会话开头的那段话。
 * 刻意写清「这来自哪次抓取」，因为新会话里模型没有这段记忆。
 */
/** 固定格式的本地时间：`2026-11-06 00:45`（不用 toLocaleString，避免随系统语言变样）。 */
function stamp(at) {
  const date = at ? new Date(at) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 生成新会话的首条消息。
 *
 * 版式刻意最简：一行来源 + 正文 + 当时的评语 + 一句指令。
 * 不写「【看一眼】」这类标签——会话标题已经写明出处，正文里再喊一遍只会
 * 让模型围着「这是你之前抓的」说元话。时间保留，因为内容有时效性时会用上。
 */
/**
 * 一条记录里能带进新会话的图片（相对路径）。
 *
 * 三类记录来源不同：多画面用 images[]，看一阵用 timeline[].sheet（每段一张拼图），
 * 单画面用 image/thumb。不统一收在这里的话，开新会话很容易只带上第一张。
 *
 * @param {object} record
 * @param {number} [limit]
 * @returns {string[]}
 */
export function recordImagePaths(record, limit = 9) {
  const out = [];
  if (record?.kind === 'watch' && Array.isArray(record.timeline)) {
    for (const win of record.timeline) {
      const rel = String(win?.sheet ?? '');
      if (rel) out.push(rel);
    }
  }
  if (out.length === 0 && Array.isArray(record?.images)) {
    for (const one of record.images) {
      const rel = one?.image || one?.thumb;
      if (rel) out.push(rel);
    }
  }
  if (out.length === 0) {
    const single = record?.image || record?.thumb;
    if (single) out.push(single);
  }
  return [...new Set(out)].slice(0, Math.max(1, limit));
}

export function describeRecord(record, { attached = 0 } = {}) {
  const isText = String(record.via ?? '') === 'selection' || Boolean(String(record.text ?? '').trim());
  const app = String(record.app || '').trim();
  const title = String(record.title || '').trim();
  const source = title ? (app ? `${app}「${title}」` : title) : app;
  const when = stamp(record.at);
  // 只有文字、又不知道来自哪个应用时，不硬写「未知应用」——那既没用也显得像占位符。
  // 这种情况只留时间（内容的时效性仍然有意义），或者干脆什么都不写。
  const lines = [source ? `来源：${source}${when ? ` · ${when}` : ''}` : when].filter(Boolean);

  if (isText) {
    lines.push('', String(record.text ?? '').slice(0, 2000));
  }
  const shots = Array.isArray(record.images) ? record.images.length : 0;
  const watchSegments = record.kind === 'watch' && Array.isArray(record.timeline) ? record.timeline.length : 0;
  if (watchSegments > 0) {
    lines.push('', `这是一段「看一阵」的录制，共 ${watchSegments} 段${attached > 0 ? `，附上 ${attached} 张画面拼图` : ''}。`);
  } else if (shots > 1) {
    lines.push('', `这组一共 ${shots} 张画面${attached > 0 ? `（已附上前 ${attached} 张）` : ''}。`);
  }
  if (record.answer) {
    lines.push('', `当时的评语：${record.answer}`);
  }
  lines.push(
    '',
    isText
      ? '先只用两三句话说明这段文字值得注意的点，然后停下等我提问；不要主动调用工具或执行操作。'
      : shots > 1
        ? '先只用两三句话概述这组画面里值得注意的点，然后停下等我提问；不要主动调用工具或执行操作。'
        : '先只用两三句话概述这张图里值得注意的点，然后停下等我提问；不要主动调用工具或执行操作。',
  );
  return lines.join('\n');
}

/** 兼容旧调用：把消息也塞进种子（会话不会产生一轮，侧边栏可能不显示）。 */
export function buildSeedEvents({ text, image = null, title = '' }) {
  const { seed, message } = buildSessionSeed({ text, image, title });
  return [
    ...seed,
    {
      type: 'user/message',
      seq: seed.length,
      time: Date.now(),
      surfaceOp: 'append',
      data: message,
    },
  ];
}
