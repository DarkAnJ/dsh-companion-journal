/**
 * 「看一眼」：看你刚才在用的那个窗口，然后让桌宠说一句有内容的反馈。
 *
 * 为什么不是「看前台窗口」：这个按钮只能在前端点，点的时候前台必然是 DSH 自己。
 * 所以它找的是**你最近在用的那个窗口**（CGWindowList 里 DSH 下面的第一个），
 * 截它的图（按 windowId 后台截，不激活、不抢焦点），再让模型看一眼说一句。
 *
 * 三条约束：
 *   1. **不改变前台**：只按 windowId 截图，绝不 activate 目标应用。
 *   2. **不改变「前台窗口」的定义**：其它工具和旁观器仍然只认真正的前台，这里是独立的一条路。
 *   3. 任何失败都降级成一句人话，不让按钮点了没反应。
 *
 * @module dsh-companion-journal/lib/look
 */

import { BridgeError, captureScreen, cursorScreen, frontApp, listWindows, ocrImage, pngSize, runProcess, screens } from './native.js';
import { say } from './surface.js';
import { pickRecentWindow } from './policy.js';
import { PAGE_SIZE, paginate } from './collect.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 最近一次抓取（进程内存，热键触发时才写；不轮询、不落盘）。 */
let lastCapture = null;

/** 读最近一次抓取；没有则返回 null。 */
export function readLastCapture() {
  return lastCapture;
}

/** 记一次抓取（只留摘要，文本截断，避免长期占内存）。 */
function remember(entry) {
  lastCapture = {
    via: entry.via,
    appName: String(entry.appName ?? ''),
    windowTitle: String(entry.windowTitle ?? ''),
    text: String(entry.text ?? '').slice(0, 4000),
    at: Date.now(),
  };
  return lastCapture;
}

/** 让模型只说一句人话：短、具体、不客套。 */
/** 让模型用最低档推理：只要能挑到，就给一个最省的值；挑不到就不传（不同模型支持的档位不同）。 */
function lowestEffort(info) {
  const efforts = info?.reasoning?.efforts;
  if (!Array.isArray(efforts)) return undefined;
  const ids = efforts.map((e) => String(e?.id ?? ''));
  for (const want of ['minimal', 'low', 'none']) {
    if (ids.includes(want)) return want;
  }
  return undefined;
}

/** 「看一眼」的默认输出预算。推理也算进 maxTokens，给窄了正文会被思考吃光。 */
const LOOK_MAX_TOKENS = 4000;
/** 多图 / 多页合成的预算：输入更长、要写的也更多。 */
const LOOK_MAX_TOKENS_HEAVY = 6000;

/**
 * 跑一次流式补全，带「推理吃光 token」的自动重试。
 *
 * 为什么需要：推理也算进 maxTokens。推理型模型偶尔把预算全花在思考上，
 * 正文一个字都不剩——钱花了、信息没有，用户只看到一条报错。
 * 所以预算给宽，并且在没有正文、但确实有推理输出（或 finish 指向额度用完）
 * 时，把预算翻倍再试一次；第二次还空才报错。
 *
 * @returns {Promise<{ok: boolean, text?: string, reason?: string}>}
 */
export async function streamText({ llm, provider, model, system, messages, effort, maxTokens = LOOK_MAX_TOKENS, logger }) {
  let budget = maxTokens;
  let lastSeen = { reasoning: 0, finish: 'none' };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const parts = [];
    const seen = { reasoning: 0, finish: 'none' };
    try {
      for await (const chunk of llm.stream({
        provider,
        model,
        system,
        messages,
        ...(effort ? { reasoningEffort: effort } : {}),
        maxTokens: budget,
      })) {
        if (chunk?.type === 'text-delta') {
          parts.push(String(chunk.text ?? ''));
        } else if (chunk?.type === 'reasoning-delta') {
          seen.reasoning += 1;
        } else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && parts.length === 0) {
          parts.push(String(chunk.block.text ?? ''));
        } else if (chunk?.type === 'finish') {
          seen.finish = chunk.reason?.kind ?? 'unknown';
          if (chunk.reason?.kind === 'error') {
            return { ok: false, reason: String(chunk.reason.failure?.message ?? '模型调用失败') };
          }
        }
      }
    } catch (error) {
      return { ok: false, reason: `模型调用失败：${String(error?.message ?? error)}` };
    }
    const text = parts.join('').trim();
    if (text) return { ok: true, text };
    lastSeen = seen;
    const exhausted = seen.reasoning > 0 || ['length', 'max-tokens', 'maxTokens'].includes(seen.finish);
    if (!exhausted) break;
    logger?.info?.(`[dsh-companion-journal] 没有正文（推理块 ${seen.reasoning}，finish=${seen.finish}），预算 ${budget} → ${budget * 2} 重试`);
    budget = Math.min(16000, budget * 2);
  }
  return {
    ok: false,
    reason:
      `模型没有给出正文（finish=${lastSeen.finish}，推理块 ${lastSeen.reasoning}）` +
      (lastSeen.reasoning > 0 ? '：推理吃光了 token，已自动放大预算重试一次' : ''),
  };
}

/**
 * 系统提示词统一由 `lib/prompt.js` 组装：
 * 骨架（不变量）+ 长度预设 + 人设。这里不再自己拼字符串。
 */
import { buildLookSystem } from './prompt.js';

/**
 * 找到目标窗口：**前台是谁就看谁**，只跳过桌宠自己。
 *
 * 之前这里有个「前台是 DSH 就退回上一个窗口」的特判，理由是点桌宠会抢焦点。
 * 现在浮窗是 nonactivating panel，不再抢焦点，那个特判反而造成：
 * 用户在 DSH 里按热键时，看到的是上一次用的别的窗口。已删除。
 *
 * @returns {Promise<{target: object, via: 'front'|'recent'}|{reason: string}>}
 */
/**
 * 「看一眼」气泡上的目标描述：窗口名 + 标题，桌面则写整屏。
 *
 * 气泡只在一行里显示，所以标题截到 18 字；拿不到应用名时退回「当前窗口」。
 *
 * @param {object|null} front frontApp 的返回
 * @returns {string}
 */
export function targetLabel(front, { appOnly = false } = {}) {
  if (!front) return '当前窗口';
  if (front.desktop === true) return '整屏';
  const app = String(front.name ?? '').trim();
  // 气泡只放应用名：窗口标题常常很长（视频标题、文档名），一行放不下还容易截得难看。
  if (appOnly) return app || '当前窗口';
  const title = String(front.windowTitle ?? '').trim();
  const clipped = title.length > 18 ? `${title.slice(0, 18)}…` : title;
  if (app && clipped) return `${app}「${clipped}」`;
  if (app) return app;
  if (clipped) return `「${clipped}」`;
  return '当前窗口';
}

export async function resolveLookTarget(ctx, { frontSnapshot = null } = {}) {
  // 优先用调用方「按下热键那一刻」拍下的前台快照：
  // 任何界面（气泡/面板）都可能在我们读完之前改变前台，快照能避免这种竞态。
  const front = frontSnapshot ?? (await frontApp(ctx));
  const frontInfo = { appName: String(front.name ?? ''), bundleId: String(front.bundleId ?? '') };
  const frontIsBuddy = /dsh-buddy/i.test(String(front.name ?? '')) || /dsh-buddy/i.test(String(front.bundleId ?? ''));

  // 桌面 / 通知中心 / 聚焦搜索这类「没有普通窗口」的场景：整屏截图。
  // 判定用光标位置（可靠），不用 AX 焦点窗口——Finder 在桌面状态下仍会报上次的窗口。
  // 只认桥给出的 desktop：它内部已经把「Finder + 光标在桌面」合进来；
  // 单独用 cursorOverDesktop 会把「光标刚好停在壁纸上」误判成整屏截图。
  const desktop = front.desktop === true;
  if (!frontIsBuddy && !desktop) {
    return {
      via: 'front',
      front: frontInfo,
      target: {
        windowId: Number(front.windowId ?? 0),
        appName: String(front.name ?? ''),
        bundleId: String(front.bundleId ?? ''),
        pid: Number(front.pid ?? 0),
        windowTitle: String(front.windowTitle ?? ''),
      },
    };
  }

  if (desktop) {
    return {
      via: 'desktop',
      front: frontInfo,
      target: {
        windowId: 0,
        appName: '桌面',
        bundleId: '',
        pid: 0,
        windowTitle: '',
        desktop: true,
      },
    };
  }

  // 只有前台真的是桌宠自己时，才退回「最近用过的真实窗口」。
  const list = await listWindows(ctx, { includeUntitled: false });
  const recent = pickRecentWindow(list.windows ?? []);
  if (!recent) {
    return { reason: '前台只有桌宠自己，我看不到别的窗口。' };
  }
  return { via: 'recent', front: frontInfo, target: recent };
}

/**
 * 用当前会话的模型看一眼这张图，返回一句话。
 * @returns {Promise<{ok:true,text:string}|{ok:false,reason:string}>}
 */
async function describeImage({ ctx, bytes, mediaType = 'image/png', target, logger, question = '', length = 'normal' }) {
  const llm = ctx?.get?.('llm');
  if (!llm || typeof llm.stream !== 'function') return { ok: false, reason: '宿主没有模型服务' };

  const selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? {};
  const provider = String(selection.provider ?? '');
  const model = String(selection.model ?? '');
  if (!provider || !model) return { ok: false, reason: '拿不到当前模型' };

  let info;
  try {
    info = await llm.resolveModelInfo(provider, model);
  } catch (error) {
    return { ok: false, reason: `模型能力查询失败：${String(error?.message ?? error)}` };
  }
  if (!Array.isArray(info?.inputModalities) || !info.inputModalities.includes('image')) {
    return { ok: false, reason: `当前模型 ${model} 不支持图片输入` };
  }

  const attachments = ctx?.get?.('attachments');
  if (!attachments || typeof attachments.saveImages !== 'function') {
    return { ok: false, reason: '宿主没有挂载附件服务' };
  }
  let imageBlock;
  try {
    const refs = await attachments.saveImages([{ data: new Uint8Array(bytes), mediaType, name: 'window.png' }]);
    const ref = Array.isArray(refs) ? refs[0] : refs;
    if (!ref) return { ok: false, reason: '附件服务没有返回引用' };
    imageBlock = { type: 'image', attachment: ref };
  } catch (error) {
    return { ok: false, reason: `附件保存被拒：${String(error?.message ?? error)}` };
  }

  // 按模型支持的最低档推理（deepseek-flash 不支持 minimal，所以动态取）。
  const effort = lowestEffort(info);
  // 桌面/整屏：告诉模型这是整块屏幕，而不是某个窗口，否则它会去找“窗口标题”。
  const isDesktop = target.desktop === true || Number(target.windowId ?? 0) === 0;
  const where = isDesktop
    ? '整个屏幕（可能是桌面，也可能浮着通知中心/聚焦搜索这类系统浮层）'
    : target.windowTitle
      ? `${target.appName}「${target.windowTitle}」`
      : target.appName;
  const system = buildLookSystem({ length, question: Boolean(question) });
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: question
            ? `这是我刚才在看的：${where}。我的问题是：${question}`
            : `这是我刚才在看的：${where}。看一眼，说一句。`,
        },
        imageBlock,
      ],
    },
  ];

  const result = await streamText({ llm, provider, model, system, messages, effort, logger });
  if (!result.ok) return result;
  const text = result.text.replace(/^["'“”]|["'“”]$/g, '').trim();
  if (!text) return { ok: false, reason: '模型没有给出正文' };
  logger?.info?.(`[dsh-companion-journal] 看一眼：${where} → ${text.slice(0, 60)}`);
  return { ok: true, text: text.slice(0, 120) };
}


/**
 * 存两份图：列表用的缩略图 + 点开看的原图。
 *
 * 原图转成 JPEG（quality 78）而不是保留 PNG：截图多是界面截图，JPEG 在这类画面上
 * 体积能小 5–10 倍，文字仍然清晰；`-Z 1600` 只是兜底，正常截图本来就不超过这个宽度。
 */
async function saveImages({ ctx, history, bytes }) {
  if (!history || history.keepImages === 'none') return { thumb: '', image: '' };
  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), 'dsh-companion-journal-img-'));
    const src = join(dir, 'shot.png');
    await writeFile(src, bytes);
    const id = history.makeId();

    const thumbName = `${id}.png`;
    const thumbPath = join(history.thumbsDir, thumbName);
    const thumb = await runProcess(ctx, ['/usr/bin/sips', '-Z', String(history.maxThumbWidth), src, '--out', thumbPath], {
      timeoutMs: 15000,
      allowNonZero: true,
    });

    let imageRel = '';
    if (history.keepImages === 'full') {
      const imageName = `${id}.jpg`;
      const imagePath = join(history.imagesDir, imageName);
      const full = await runProcess(
        ctx,
        ['/usr/bin/sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '78', '-Z', '1600', src, '--out', imagePath],
        { timeoutMs: 20000, allowNonZero: true },
      );
      if (full.code === 0) imageRel = `images/${imageName}`;
    }

    return {
      thumb: thumb.code === 0 ? `thumbs/${thumbName}` : '',
      image: imageRel,
    };
  } catch {
    return { thumb: '', image: '' };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 纯文本版：同一个提示词，喂选中的那段文字。 */
async function describeText({ ctx, text, logger, question = '', length = 'normal' }) {
  const llm = ctx?.get?.('llm');
  if (!llm || typeof llm.stream !== 'function') return { ok: false, reason: '宿主没有模型服务' };
  const selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? {};
  const provider = String(selection.provider ?? '');
  const model = String(selection.model ?? '');
  if (!provider || !model) return { ok: false, reason: '拿不到当前模型' };

  let effort;
  try {
    effort = lowestEffort(await llm.resolveModelInfo(provider, model));
  } catch {
    effort = undefined;
  }

  const system = buildLookSystem({ length, question: Boolean(question) });
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: question
            ? `这是我选中的一段文字，我的问题是：${question}\n\n${text.slice(0, 6000)}`
            : `这是我选中的一段文字，看一眼，说一句：\n\n${text.slice(0, 6000)}`,
        },
      ],
    },
  ];
  const result = await streamText({ llm, provider, model, system, messages, effort, logger });
  if (!result.ok) return result;
  const out = result.text.replace(/^["'“”]|["'“”]$/g, '').trim();
  if (!out) return { ok: false, reason: '模型没有给出正文' };
  logger?.info?.(`[dsh-companion-journal] 看一眼（选中）：${out.slice(0, 60)}`);
  return { ok: true, text: out.slice(0, 120) };
}


/**
 * 「看一眼」的完整动作：找窗口 → 截图 → 模型看一眼 → 桌宠说。
 *
 * @returns {Promise<object>} 纯 JSON，直接给命令 / 面板用
 */
export async function lookOnce({ ctx, config, logger, selectedText = '', selectedApp = '', history = null, mode = 'f8', question = '', askQuestion = null, frontSnapshot = null, desktopScreen = null }) {
  /** 这次「桌面」截图用的区域（诊断：截错屏时能一眼看出）。 */
  let captureRegion = null;
  /** 桌面多屏时的所有截图；非桌面为空。 */
  let deskShots = [];
  // F7：抓取之后、调模型之前弹窗问一句。取消 = 整条链路作废（不花钱、不留记录）。
  let asked = String(question ?? '').trim();
  async function askNow() {
    if (asked !== '' || typeof askQuestion !== 'function') return asked;
    const answer = await askQuestion();
    // null = 用户取消；空串 = 直接回车，按「就看一眼」处理（不该打断）。
    if (answer === null || answer === undefined) return null;
    asked = String(answer).trim();
    return asked;
  }
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  // 有选中就只处理这段文字：比截图便宜、也更准（不依赖窗口可见性）。
  const selected = String(selectedText ?? '').trim();
  if (selected !== '') {
    if (typeof askQuestion === 'function') {
      const got = await askNow();
      if (got === null) return { ok: false, stage: 'cancelled', via: 'selection' };
    }
    const described = await describeText({
      ctx,
      text: selected,
      logger,
      question: asked,
      length: config?.look?.length ?? 'normal',
    });
    if (!described.ok) return { ok: false, stage: 'describe', error: described.reason, via: 'selection' };
    remember({ via: 'selection', appName: selectedApp, text: selected });
    // 先落盘再说话：气泡要知道自己对应哪条记录，点它才能打开并定位。
    const record = history?.append({
      mode,
      app: selectedApp,
      via: 'selection',
      text: selected.slice(0, 8000),
      question: asked,
      answer: described.text,
      ms: elapsed(),
    });
    const spoken = await say(ctx, described.text, { recordId: record?.id });
    return {
      ok: true,
      via: 'selection',
      text: described.text,
      ms: elapsed(),
      spoken: Boolean(spoken.ok),
      speakError: spoken.ok ? undefined : String(spoken.reason ?? ''),
    };
  }

  let resolved;
  try {
    resolved = await resolveLookTarget(ctx, { frontSnapshot });
  } catch (error) {
    return { ok: false, stage: 'target', error: String(error?.message ?? error) };
  }
  if (!resolved.target) return { ok: false, stage: 'target', error: resolved.reason };

  const target = resolved.target;
  let shot;
  try {
    // 桌面不是窗口：**每块屏各截一张**，一起交给模型。
    // 不猜「用户在看哪块」——猜就得跟踪光标，而持续监控是我们明确不做的。
    if (target.desktop) {
      const list = await screens(ctx);
      if (list.length === 0) return { ok: false, stage: 'capture', error: '没有可截的显示器', target };
      for (const one of list) {
        const snapped = await captureScreen(ctx, { windowId: 0, region: one });
        deskShots.push({ bytes: snapped.bytes, screen: one });
      }
      shot = deskShots[0];
      captureRegion = list[0];
    } else {
      shot = await captureScreen(ctx, { windowId: target.windowId });
    }
  } catch (error) {
    const hint =
      error instanceof BridgeError && error.code === 'no-permission'
        ? '没有屏幕录制授权'
        : String(error?.message ?? error);
    return { ok: false, stage: 'capture', error: hint, target };
  }

  // 截图已经拿到手，此刻再弹输入框，不会把自己截进去。
  if (typeof askQuestion === 'function') {
    const got = await askNow();
    if (got === null) return { ok: false, stage: 'cancelled', target };
  }
  const described =
    deskShots.length > 1
      ? await describeScreens({
          ctx,
          shots: deskShots,
          target,
          logger,
          question: asked,
          length: config?.look?.length ?? 'normal',
        })
      : await describeImage({
          ctx,
          bytes: shot.bytes,
          target,
          logger,
          question: asked,
          length: config?.look?.length ?? 'normal',
        });
  if (!described.ok) {
    return { ok: false, stage: 'describe', error: described.reason, target };
  }

  remember({ via: resolved.via, appName: target.appName, windowTitle: target.windowTitle, text: described.text });
  const saved = await saveImages({ ctx, history, bytes: shot.bytes });
  let extraImages = [];
  if (deskShots.length > 1) {
    for (const one of deskShots.slice(1)) {
      const extra = await saveImages({ ctx, history, bytes: one.bytes });
      if (extra.thumb) extraImages.push({ thumb: extra.thumb, image: extra.image, text: '' });
    }
  }
  const record = history?.append({
    mode,
    app: target.appName,
    title: target.windowTitle,
    via: 'window',
    thumb: saved.thumb,
    image: saved.image,
    // 诊断字段：这条记录到底是按「窗口」还是「桌面/整屏」判定的。
    targetVia: resolved.via,
    targetWindowId: Number(target.windowId ?? 0),
    targetDesktop: Boolean(target.desktop),
    targetRegion: captureRegion
      ? `${captureRegion.x},${captureRegion.y},${captureRegion.w},${captureRegion.h}` +
        (Number.isFinite(captureRegion.mouseX) ? ` @mouse ${captureRegion.mouseX},${captureRegion.mouseY}` : '')
      : '',
    question: asked,
    answer: described.text,
    ms: elapsed(),
    ...(extraImages.length > 0
      ? { kind: 'multi', images: [{ thumb: saved.thumb, image: saved.image, text: '' }, ...extraImages] }
      : {}),
  });
  // 画面文字：**后台**补 OCR 再回写记录（只用于搜索，不展示、不影响这次回答）。
  // 放后台是因为它约 0.4s，挡在气泡前面会被感知成「卡」。
  if (record?.id) {
    void ocrImage(ctx, shot.bytes)
      .then((ocr) => {
        const text = String(ocr?.text ?? '').trim();
        if (text) history?.update?.(record.id, { ocr: text });
      })
      .catch(() => {});
  }

  const spoken = await say(ctx, described.text, { recordId: record?.id });
  return {
    ok: true,
    via: resolved.via,
    front: resolved.front ?? null,
    target: { appName: target.appName, windowTitle: target.windowTitle, windowId: target.windowId },
    text: described.text,
    ms: elapsed(),
    spoken: Boolean(spoken.ok),
    speakError: spoken.ok ? undefined : String(spoken.reason ?? ''),
    size: pngSize(shot.bytes),
  };
}

/**
 * 多屏桌面：一次把每块屏的截图都交给模型，并标出哪张是哪块屏。
 *
 * 为什么不做「选一块」：选就得知道用户在看哪块——那要靠跟踪光标，属于持续监控。
 * 多给一张图更贵一点，但行为稳定、两条入口一致。
 */
async function describeScreens({ ctx, shots, target, logger = null, question = '', length = 'normal' }) {
  const llm = ctx?.get?.('llm');
  if (!llm || typeof llm.stream !== 'function') return { ok: false, reason: '宿主没有模型服务' };
  const selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? {};
  const provider = String(selection.provider ?? '');
  const model = String(selection.model ?? '');
  if (!provider || !model) return { ok: false, reason: '拿不到当前模型' };

  const attachments = ctx?.get?.('attachments');
  if (!attachments || typeof attachments.saveImages !== 'function') {
    return { ok: false, reason: '宿主没有挂载附件服务' };
  }

  const content = [
    {
      type: 'text',
      text: question
        ? `这是我屏幕上的全部画面（共 ${shots.length} 块屏）。我的问题是：${question}`
        : `这是我屏幕上的全部画面（共 ${shots.length} 块屏）。看一眼，说一句。`,
    },
  ];
  for (const [index, one] of shots.entries()) {
    content.push({ type: 'text', text: `— 屏幕 ${index + 1}：${one.screen.name || '显示器'} —` });
    try {
      const refs = await attachments.saveImages([
        { data: new Uint8Array(one.bytes), mediaType: 'image/png', name: `screen-${index}.png` },
      ]);
      const ref = Array.isArray(refs) ? refs[0] : refs;
      if (ref) content.push({ type: 'image', attachment: ref });
    } catch {
      /* 单张失败就跳过 */
    }
  }

  const info = await llm.resolveModelInfo(provider, model).catch(() => null);
  const effort = lowestEffort(info);
  const result = await streamText({
    llm,
    provider,
    model,
    system: buildLookSystem({ length, question: Boolean(question) }),
    messages: [{ role: 'user', content }],
    effort,
    logger,
  });
  return result.ok ? { ok: true, text: result.text.slice(0, 200) } : result;

}

/**
 * 收集模式的一次抓取：截图 + 本地 OCR，**不调模型**。
 *
 * 与 `lookOnce` 的区别只在于「不花 token」：多画面收集时每按一次 F8 就走这里。
 */
export async function captureForCollect({ ctx, history, frontSnapshot = null, ocrNow = true, desktopScreen = null }) {
  let resolved;
  try {
    resolved = await resolveLookTarget(ctx, { frontSnapshot });
  } catch (error) {
    return { ok: false, stage: 'target', error: String(error?.message ?? error) };
  }
  if (!resolved.target) return { ok: false, stage: 'target', error: resolved.reason };

  const target = resolved.target;
  let shot;
  const deskShots = [];
  try {
    if (target.desktop) {
      const list = await screens(ctx);
      if (list.length === 0) return { ok: false, stage: 'capture', error: '没有可截的显示器', target };
      for (const one of list) {
        const snapped = await captureScreen(ctx, { windowId: 0, region: one });
        deskShots.push({ bytes: snapped.bytes, screen: one });
      }
      shot = deskShots[0];
    } else {
      shot = await captureScreen(ctx, { windowId: target.windowId });
    }
  } catch (error) {
    return { ok: false, stage: 'capture', error: String(error?.message ?? error), target };
  }

  const saved = await saveImages({ ctx, history, bytes: shot.bytes });

  // OCR 是「增强项」，不该挡在用户感知的路径上：
  // 默认同步做（调用方简单），多画面收集时传 ocrNow=false —— 先把图收下巴并更新气泡，
  // OCR 在后台跑，结束分析前再等它（见 finishCollection）。
  if (!ocrNow) {
    const pending = ocrImage(ctx, shot.bytes).catch(() => ({ text: '', lines: [] }));
    return {
      ok: true,
      target,
      via: resolved.via,
      thumb: saved.thumb,
      image: saved.image,
      text: '',
      bytes: shot.bytes,
      pendingOcr: pending,
    };
  }

  const ocr = await ocrImage(ctx, shot.bytes);
  return {
    ok: true,
    target,
    via: resolved.via,
    thumb: saved.thumb,
    image: saved.image,
    text: ocr.text,
    bytes: shot.bytes,
  };
}

/**
 * 多画面分析：把一次收集的若干张按 9 张一页分批，再合成一个结论。
 *
 * 为什么分页而不是一次全发：单次请求的图片数过多会超限，也会让模型前面看清、后面糊。
 * 只有一页时直接回答；多页时先逐页小结，再对小结做一次汇总——这就是 map-reduce。
 */
export async function describeCollection({ ctx, items, question = '', length = 'normal', logger = null }) {
  const pages = paginate(items, PAGE_SIZE);
  if (pages.length === 0) return { ok: false, reason: '没有可分析的画面' };

  const pageSummaries = [];
  for (const [index, page] of pages.entries()) {
    const result = await describePage({ ctx, page, question, length, pageIndex: index, total: pages.length, logger });
    if (!result.ok) return { ok: false, reason: result.reason };
    pageSummaries.push(result.text);
    if (pages.length > 1) logger?.info?.(`[dsh-companion-journal] 多画面：第 ${index + 1}/${pages.length} 页已看完`);
  }

  if (pageSummaries.length === 1) return { ok: true, text: pageSummaries[0] };

  // 多页：把各页小结再合成一次（这一步没有图片，便宜）。
  const merged = await synthesize({ ctx, summaries: pageSummaries, question, length, logger });
  return merged.ok ? { ok: true, text: merged.text } : merged;
}

/** 一页（≤9 张）的问答。 */
async function describePage({ ctx, page, question, length, pageIndex, total, logger = null }) {
  const llm = ctx?.get?.('llm');
  if (!llm || typeof llm.stream !== 'function') return { ok: false, reason: '宿主没有模型服务' };
  const selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? {};
  const provider = String(selection.provider ?? '');
  const model = String(selection.model ?? '');
  if (!provider || !model) return { ok: false, reason: '拿不到当前模型' };

  const attachments = ctx?.get?.('attachments');
  if (!attachments || typeof attachments.saveImages !== 'function') {
    return { ok: false, reason: '宿主没有挂载附件服务' };
  }

  const content = [];
  const intro = question
    ? `这是我连续截的 ${page.length} 张画面（第 ${pageIndex + 1}/${total} 页）。我的问题：${question}`
    : `这是我连续截的 ${page.length} 张画面（第 ${pageIndex + 1}/${total} 页）。看看这一组画面在讲什么。`;
  content.push({ type: 'text', text: intro });

  for (const [index, item] of page.entries()) {
    const globalIndex = pageIndex * PAGE_SIZE + index + 1;
    const text = String(item.text ?? '').trim();
    content.push({
      type: 'text',
      text: `— 第 ${globalIndex} 张 —${text ? `\n画面文字（OCR）：${text.slice(0, 1200)}` : '\n（没有识别到文字）'}`,
    });
    try {
      const bytes = await readFileItem(item);
      if (!bytes) continue;
      const refs = await attachments.saveImages([{ data: new Uint8Array(bytes), mediaType: 'image/png', name: `page-${index}.png` }]);
      const ref = Array.isArray(refs) ? refs[0] : refs;
      if (ref) content.push({ type: 'image', attachment: ref });
    } catch {
      /* 单张图存不进去就跳过它，不影响其它张 */
    }
  }

  const system = buildLookSystem({ length, question: Boolean(question) });
  const info = await llm.resolveModelInfo(provider, model).catch(() => null);
  const effort = lowestEffort(info);
  const result = await streamText({
    llm,
    provider,
    model,
    system,
    messages: [{ role: 'user', content }],
    effort,
    logger,
    maxTokens: LOOK_MAX_TOKENS_HEAVY,
  });
  return result.ok ? { ok: true, text: result.text } : result;
}

/** 多页小结的合成（无图）。 */
async function synthesize({ ctx, summaries, question, length, logger = null }) {
  const llm = ctx?.get?.('llm');
  if (!llm || typeof llm.stream !== 'function') return { ok: false, reason: '宿主没有模型服务' };
  const selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? {};
  const provider = String(selection.provider ?? '');
  const model = String(selection.model ?? '');
  const info = await llm.resolveModelInfo(provider, model).catch(() => null);
  const effort = lowestEffort(info);
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            (question ? `我的问题：${question}\n\n` : '') +
            '下面是我分页看过的记录，请合成一个完整回答：\n\n' +
            summaries.map((text, index) => `【第 ${index + 1} 页】\n${text}`).join('\n\n'),
        },
      ],
    },
  ];
  const result = await streamText({
    llm,
    provider,
    model,
    system: buildLookSystem({ length, question: Boolean(question) }),
    messages,
    effort,
    logger,
    maxTokens: LOOK_MAX_TOKENS_HEAVY,
  });
  return result.ok ? { ok: true, text: result.text } : result;
}

/** 读一张收集图：优先内存字节，其次磁盘。 */
async function readFileItem(item) {
  if (item.bytes) return item.bytes;
  if (item.absolutePath) return readFile(item.absolutePath).catch(() => null);
  return null;
}
