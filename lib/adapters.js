/**
 * 读取适配器：把「当前窗口」翻译成模型能读的文本。
 *
 * 设计原则是「文本优先」：能拿到文本就不截图。理由不是省 token，而是准确性 ——
 * 对 Word 来说，AppleScript 拿到的是文档真实字符；截图再 OCR 一遍，既慢又会在
 * 公式、脚注、双栏排版上出错。只有拿不到文本的窗口（视频、画布、扫描件）才走截图。
 *
 * 每个适配器失败都必须给出**可操作的**原因：
 *   automation-denied → 去系统设置给自动化授权
 *   zotero-api-off    → 去 Zotero 高级设置里打开本地 API
 *   no-text-layer     → 这是扫描版 PDF，改用截图
 * 含糊的 "read failed" 等于把排障成本全丢给用户。
 *
 * @module dsh-companion-journal/lib/adapters
 */

import { BridgeError, axText, frontApp, pdfText, runAppleScript } from './native.js';

const WORD_BUNDLES = ['com.microsoft.word'];
const ZOTERO_BUNDLES = ['org.zotero.zotero', 'org.zotero.zotero6', 'org.zotero.zotero7'];
const PREVIEW_BUNDLES = ['com.apple.preview'];
const SKIM_BUNDLES = ['net.sourceforge.skim-app.skim'];
const CHROME_BUNDLES = ['com.google.chrome', 'org.chromium.chromium', 'com.microsoft.edgemac'];
const SAFARI_BUNDLES = ['com.apple.safari'];

function isOneOf(bundleId, list) {
  const id = String(bundleId ?? '').toLowerCase();
  return list.some((x) => id === x || id.startsWith(x));
}

/** 截断文本但明确标注，避免模型以为自己看到了全文。 */
function clamp(text, maxChars) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return { text: s, truncated: false };
  return { text: s.slice(0, maxChars), truncated: true };
}

/** Word：正文 + 保存路径。路径比正文更有用（能直接读 docx 的样式与批注）。 */
async function readWord(ctx, { maxChars }) {
  const raw = await runAppleScript(
    ctx,
    [
      'tell application "Microsoft Word"',
      'if (count of documents) is 0 then return "NO_DOC"',
      'set d to active document',
      'set docName to name of d',
      'set docPath to full name of d',
      'set docText to content of d',
      'return docName & linefeed & docPath & linefeed & docText',
      'end tell',
    ],
    { timeoutMs: 15000 },
  );
  if (raw === 'NO_DOC') {
    throw new BridgeError('no-open-document', 'Word 里没有打开的文档');
  }
  const first = raw.indexOf('\n');
  const second = first >= 0 ? raw.indexOf('\n', first + 1) : -1;
  const docName = first >= 0 ? raw.slice(0, first) : raw;
  const docPath = second >= 0 ? raw.slice(first + 1, second) : '';
  const body = second >= 0 ? raw.slice(second + 1) : '';
  const clamped = clamp(body, maxChars);
  return {
    source: 'word',
    text: clamped.text,
    truncated: clamped.truncated,
    meta: { documentName: docName, documentPath: docPath, chars: body.length },
  };
}

/** Zotero：靠窗口标题去本地 API 里找条目。拿不到标题时说清楚为什么。 */
async function readZotero(ctx, { windowTitle, config }) {
  const zotero = config?.read?.zotero ?? {};
  if (zotero.enabled === false) {
    throw new BridgeError('zotero-disabled', 'Zotero 适配器已关闭（read.zotero.enabled）');
  }
  if (!windowTitle) {
    throw new BridgeError(
      'no-window-title',
      '读不到 Zotero 窗口标题，无法定位当前条目',
      '窗口标题需要「屏幕录制」授权；或者直接在对话里告诉我作者/标题',
    );
  }
  const baseUrl = String(zotero.baseUrl ?? 'http://127.0.0.1:23119').replace(/\/+$/, '');
  const url = `${baseUrl}/api/users/0/items?q=${encodeURIComponent(windowTitle)}&limit=3&format=json`;
  let response;
  try {
    response = await fetch(url, {
      headers: { 'Zotero-API-Version': '3', Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
  } catch (error) {
    throw new BridgeError(
      'zotero-api-off',
      '连不上 Zotero 本地 API',
      `在 Zotero → 设置 → 高级 里勾选「允许此计算机上的其他应用程序与 Zotero 通信」，然后重试。（${String(error?.message ?? error)}）`,
    );
  }
  if (!response.ok) {
    throw new BridgeError('zotero-api-error', `Zotero 本地 API 返回 ${response.status}`);
  }
  const items = await response.json().catch(() => null);
  if (!Array.isArray(items) || items.length === 0) {
    throw new BridgeError('zotero-no-match', 'Zotero 里没找到与窗口标题匹配的条目');
  }
  const lines = items.map((item) => {
    const data = item?.data ?? {};
    const creators = Array.isArray(data.creators)
      ? data.creators.map((c) => c.lastName ?? c.name ?? '').filter(Boolean).join(', ')
      : '';
    return [
      `标题：${data.title ?? '(无)'}`,
      creators ? `作者：${creators}` : '',
      data.date ? `日期：${data.date}` : '',
      data.publicationTitle ? `来源：${data.publicationTitle}` : '',
      data.abstractNote ? `摘要：${data.abstractNote}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });
  return {
    source: 'zotero',
    text: lines.join('\n\n---\n\n'),
    truncated: false,
    meta: { matches: items.length, query: windowTitle },
  };
}

/** Preview / Skim：拿到文件路径后走 PDF 文本层。 */
async function readPdfFromEditor(ctx, { appName, maxChars }) {
  const app = appName?.toLowerCase().includes('skim') ? 'Skim' : 'Preview';
  let path;
  try {
    path = await runAppleScript(
      ctx,
      [`tell application "${app}"`, 'if (count of documents) is 0 then return "NO_DOC"', 'return path of front document', 'end tell'],
      { timeoutMs: 8000 },
    );
  } catch (error) {
    if (error instanceof BridgeError && error.code === 'automation-denied') {
      throw new BridgeError(
        'automation-denied',
        `没有操控 ${app} 的自动化授权`,
        `到 系统设置 → 隐私与安全性 → 自动化，允许 DeepSeek Harness 控制 ${app}`,
      );
    }
    throw error;
  }
  if (!path || path === 'NO_DOC') {
    throw new BridgeError('no-open-document', `${app} 里没有打开的文档`);
  }
  let result;
  try {
    result = await pdfText(ctx, path, { maxChars });
  } catch (error) {
    throw new BridgeError('pdf-failed', `读不了 PDF：${path}`, String(error?.message ?? error));
  }
  const text = String(result.text ?? '');
  if (text.trim() === '') {
    throw new BridgeError(
      'no-text-layer',
      '这个 PDF 没有文本层（扫描版）',
      '改用 companion_capture 截图，让我直接看图',
    );
  }
  return {
    source: 'pdf',
    text,
    truncated: Boolean(result.truncated),
    meta: { path, pages: result.pages ?? null },
  };
}

/**
 * 浏览器只给「元信息」，不给正文。
 *
 * 正文要 DOM，而 DOM 在浏览器进程里 —— 那需要扩展桥（P4）。在那之前，
 * 与其用截图冒充正文，不如明确只给标题/URL/空闲时间，让模型知道该要截图。
 */
function readBrowserMeta(front) {
  return {
    source: 'browser-meta',
    text: [
      `应用：${front.name}`,
      `窗口：${front.windowTitle || '(标题不可见，可能缺屏幕录制授权)'}`,
      '正文需要浏览器扩展桥（尚未安装），本轮只能看到窗口标题。',
    ].join('\n'),
    truncated: false,
    meta: { bundleId: front.bundleId, windowId: front.windowId },
  };
}

/**
 * 主入口：读当前（或指定）窗口。
 * @returns {{ app, bundleId, windowTitle, windowId, idleSeconds, source, text, truncated, meta, permissions }}
 */
export async function readFrontWindow(ctx, config, { maxChars = 12000 } = {}) {
  const front = await frontApp(ctx);
  const windowTitle = front.windowTitle ?? '';
  const base = {
    app: front.name ?? '',
    bundleId: front.bundleId ?? '',
    windowTitle,
    windowId: front.windowId ?? null,
    idleSeconds: front.idleSeconds ?? 0,
    permissions: { screenRecording: Boolean(front.screenRecording), accessibility: Boolean(front.accessibility) },
  };

  const bundleId = front.bundleId;

  if (isOneOf(bundleId, WORD_BUNDLES)) {
    return { ...base, ...(await readWord(ctx, { maxChars })) };
  }
  if (isOneOf(bundleId, ZOTERO_BUNDLES)) {
    return { ...base, ...(await readZotero(ctx, { windowTitle, config })) };
  }
  if (isOneOf(bundleId, PREVIEW_BUNDLES) || isOneOf(bundleId, SKIM_BUNDLES)) {
    return { ...base, ...(await readPdfFromEditor(ctx, { appName: front.name, maxChars })) };
  }
  if (isOneOf(bundleId, CHROME_BUNDLES) || isOneOf(bundleId, SAFARI_BUNDLES)) {
    return { ...base, ...readBrowserMeta(front) };
  }

  // 其它应用：有辅助功能授权就试焦点元素文本，否则只报窗口元信息。
  if (front.accessibility && front.pid) {
    try {
      const ax = await axText(ctx, front.pid);
      if (ax.text && String(ax.text).trim() !== '') {
        const clamped = clamp(ax.text, maxChars);
        return {
          ...base,
          source: 'accessibility',
          text: clamped.text,
          truncated: clamped.truncated,
          meta: { axWindowTitle: ax.title ?? '' },
        };
      }
    } catch {
      /* 辅助功能路径是尽力而为，失败就退回元信息 */
    }
  }

  return {
    ...base,
    source: 'window-meta',
    text: [
      `应用：${base.app || '(未知)'}`,
      `窗口：${windowTitle || '(标题不可见)'}`,
      '这个应用没有可用的文本适配器。需要内容的话用 companion_capture 截图。',
    ].join('\n'),
    truncated: false,
    meta: {},
  };
}
