/**
 * 模型可见的五个工具。
 *
 * 三条约定：
 *   1. 返回给模型的是**规范值**（纯 JSON，能被 output.schema 校验）；
 *      给人看的话由 `output.render` 生成。值里绝不放 Buffer 或函数。
 *   2. 截图走 `finalizeContent` 附成 image 内容块，不能塞进返回值
 *      （output.schema 校验不过，而且规范值必须可序列化）。
 *   3. 每个失败都翻译成「下一步该做什么」：授权、装桥、开 Zotero 开关。
 *      模型看得到这句，就能一边解释一边自我纠正。
 *
 * @module dsh-companion-journal/lib/tools
 */

import { readFrontWindow } from './adapters.js';
import { readLastCapture } from './look.js';
import { attachImage, composeCaptureContent, textBlock } from './agent.js';
import { BridgeError, captureScreen, frontApp, listWindows, pngSize } from './native.js';
import { say } from './surface.js';
import { redact } from './policy.js';

/** 每个 exec 的图片内容块暂存：finalizeContent 是同步的，附件必须提前存好。 */
const PENDING_CONTENT = new WeakMap();

function text(textValue) {
  return textBlock(textValue);
}

/** 把 BridgeError 翻译成一句模型能据以行动的话。 */
function explain(error) {
  if (error instanceof BridgeError) {
    const detail = error.detail ? `（${String(error.detail).slice(0, 300)}）` : '';
    return `${error.message}${detail}`;
  }
  return String(error?.message ?? error);
}

/**
 * @param {object} deps
 * @param {object} deps.ctx     宿主上下文
 * @param {object} deps.config  归一化后的配置
 * @param {object} deps.observer 旁观器
 * @param {object} deps.logger
 * @returns {object[]} registry-ready 工具定义（不含 @deepseek-ai 依赖）
 */
export function createTools({ ctx, config, observer, logger }) {
  const windowsTool = {
    name: 'companion_windows',
    description:
      '列出当前屏幕上的应用窗口（应用名、窗口 id、位置尺寸、是否前台）。想看「用户在做什么」但还没确定目标窗口时先用它；拿到 windowId 后可以交给 companion_capture 精确截图。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        includeUntitled: {
          type: 'boolean',
          description: '连没有标题的窗口一起列（默认只列有标题的）。缺屏幕录制授权时几乎所有窗口都没标题，此时传 true。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          frontApp: { type: 'string' },
          screenRecording: { type: 'boolean' },
          accessibility: { type: 'boolean' },
          count: { type: 'number' },
          windows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                windowId: { type: 'number' },
                ownerName: { type: 'string' },
                title: { type: 'string' },
                x: { type: 'number' },
                y: { type: 'number' },
                w: { type: 'number' },
                h: { type: 'number' },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const head = `前台：${value.frontApp || '(未知)'}；共 ${value.count} 个窗口` +
          `（屏幕录制：${value.screenRecording ? '已授权' : '未授权'}）`;
        const lines = value.windows.slice(0, 20).map(
          (w) => `- ${w.ownerName}「${w.title || '(无标题)'}」id=${w.windowId} ${w.w}×${w.h} @${w.x},${w.y}`,
        );
        return [text([head, ...lines].join('\n'))];
      },
    },
    async execute(args) {
      try {
        const raw = await listWindows(ctx, { includeUntitled: args.includeUntitled === true });
        const windows = (raw.windows ?? []).map((w) => ({
          windowId: Number(w.windowId ?? 0),
          ownerName: String(w.ownerName ?? ''),
          title: String(w.title ?? ''),
          x: Number(w.bounds?.x ?? 0),
          y: Number(w.bounds?.y ?? 0),
          w: Number(w.bounds?.w ?? 0),
          h: Number(w.bounds?.h ?? 0),
        }));
        return {
          frontApp: String(raw.frontApp?.name ?? ''),
          screenRecording: Boolean(raw.screenRecording),
          accessibility: Boolean(raw.accessibility),
          count: windows.length,
          windows,
        };
      } catch (error) {
        throw new Error(`列窗口失败：${explain(error)}`);
      }
    },
  };

  const readTool = {
    name: 'companion_read',
    description:
      '读用户当前前台窗口的内容（文本优先）：Word 取文档正文与保存路径，Zotero 按窗口标题查本地库条目，Preview/Skim 取 PDF 文本层，其它应用取窗口元信息或辅助功能焦点文本。用户让你「看看我现在写的/看的这个东西」时先调它——它比截图快、准，也更省。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxChars: {
          type: 'number',
          description: '正文最多返回多少字符，默认取配置 read.maxChars。长文档会被截断并在结果里标注。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          app: { type: 'string' },
          bundleId: { type: 'string' },
          windowTitle: { type: 'string' },
          idleSeconds: { type: 'number' },
          source: { type: 'string' },
          truncated: { type: 'boolean' },
          chars: { type: 'number' },
          text: { type: 'string' },
          meta: { type: 'object' },
          screenRecording: { type: 'boolean' },
          accessibility: { type: 'boolean' },
        },
      },
      render: (args, value) => {
        const head =
          `来源=${value.source}；应用=${value.app || '(未知)'}` +
          `；窗口=${value.windowTitle || '(无标题)'}` +
          (value.truncated ? `；已截断到 ${value.chars} 字符` : '');
        return [text(`${head}\n\n${value.text}`)];
      },
    },
    async execute(args) {
      let result;
      try {
        result = await readFrontWindow(ctx, config, {
          maxChars: Number(args.maxChars) > 0 ? Number(args.maxChars) : config.read.maxChars,
        });
      } catch (error) {
        throw new Error(`读当前窗口失败：${explain(error)}`);
      }
      const clean = redact(result.text, config.privacy.redact);
      return {
        app: result.app,
        bundleId: result.bundleId,
        windowTitle: result.windowTitle,
        idleSeconds: Number(result.idleSeconds ?? 0),
        source: result.source,
        truncated: Boolean(result.truncated),
        chars: clean.length,
        text: clean,
        meta: result.meta ?? {},
        screenRecording: Boolean(result.permissions?.screenRecording),
        accessibility: Boolean(result.permissions?.accessibility),
      };
    },
  };

  const captureTool = {
    name: 'companion_capture',
    description:
      '截一张图给模型看：当前前台窗口、指定 windowId 的窗口，或整屏。返回图片本体（模型直接能看）。需要「屏幕录制」授权；没有授权时返回明确的修复指引而不是空白图。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: {
          type: 'string',
          enum: ['front_window', 'screen'],
          description: '截哪里：front_window（默认，当前前台窗口）或 screen（整屏）。',
        },
        windowId: {
          type: 'number',
          description: '指定窗口 id（来自 companion_windows）。给了它就截这个窗口，忽略 target。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          app: { type: 'string' },
          windowTitle: { type: 'string' },
          windowId: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          attached: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
      render: (args, value) => {
        const where = value.windowId ? `窗口 ${value.windowId}（${value.app || '未知'}）` : value.target;
        return [
          text(
            value.attached
              ? `已截图：${where}，${value.width}×${value.height}，图片已附在本结果里。`
              : `截图完成但没能附成图片：${where}。${value.note ?? ''}`,
          ),
        ];
      },
    },
    finalizeContent(exec) {
      return PENDING_CONTENT.get(exec);
    },
    async execute(args, exec) {
      const wantsScreen = args.target === 'screen';
      const explicitId = Number(args.windowId) > 0 ? Number(args.windowId) : null;

      let app = '';
      let title = '';
      let windowId = explicitId;
      if (!explicitId && !wantsScreen) {
        try {
          const front = await frontApp(ctx);
          windowId = typeof front.windowId === 'number' ? front.windowId : null;
          app = String(front.name ?? '');
          title = String(front.windowTitle ?? '');
        } catch {
          /* 取不到前台信息时退回整屏，别让截图直接失败 */
        }
      }

      let shot;
      try {
        shot = await captureScreen(ctx, {
          windowId: windowId ?? undefined,
          screen: wantsScreen || !windowId,
          maxWidth: config.capture.maxWidth,
        });
      } catch (error) {
        throw new Error(`截图失败：${explain(error)}`);
      }

      const size = shot.size ?? pngSize(shot.bytes) ?? { width: 0, height: 0 };
      const attachment = await attachImage(ctx, exec, shot.bytes, shot.mediaType);
      const attached = Boolean(attachment.block);
      if (!attached) {
        try {
          logger?.warn?.(`[dsh-companion-journal] 截图没能附成图片：${attachment.reason}`);
        } catch {
          /* 日志失败不影响主流程 */
        }
      }

      const summary = [
        `截图：${app || '屏幕'}${title ? `「${title}」` : ''}${windowId ? ` id=${windowId}` : ''}`,
        `尺寸：${size.width}×${size.height}`,
      ].join('\n');
      PENDING_CONTENT.set(
        exec,
        composeCaptureContent({ summary, attached: attachment.block, failureReason: attachment.reason }),
      );

      return {
        target: windowId ? 'window' : 'screen',
        app,
        windowTitle: title,
        windowId: windowId ?? 0,
        width: size.width,
        height: size.height,
        attached,
        note: attached ? '' : String(attachment.reason ?? '未知原因'),
      };
    },
  };

  const watchTool = {
    name: 'companion_watch',
    description:
      '控制「旁观」开关：关闭时完全不采样；start 后按配置间隔看一眼前台窗口，场景变化时让桌宠说一句旁白（旁白不调模型、有频率上限）。once 立刻采样一次并给出判断结果，用来验证配置是否生效。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'start', 'pause', 'once'],
          description: 'status 查看状态；start/pause 开关旁观；once 立即采样一次。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          ticks: { type: 'number' },
          intervalMs: { type: 'number' },
          lastScene: { type: 'object' },
          lastSaid: { type: 'object' },
          lastSkip: { type: 'object' },
          rate: { type: 'object' },
          action: { type: 'string' },
          result: { type: 'string' },
        },
      },
      render: (args, value) => {
        const parts = [
          `旁观：${value.enabled ? '开' : '关'}；已采样 ${value.ticks} 次；间隔 ${value.intervalMs}ms`,
        ];
        if (value.lastScene) {
          parts.push(`上次场景：${value.lastScene.appName}「${value.lastScene.windowTitle || '无标题'}」`);
        }
        if (value.lastSaid) parts.push(`上次开口：${value.lastSaid.text}`);
        if (value.lastSkip) parts.push(`上次跳过：${value.lastSkip.reason}（${value.lastSkip.detail ?? '-'}）`);
        if (value.rate) {
          parts.push(`频率：近一小时已用 ${value.rate.usedLastHour}/${value.rate.maxPerHour}`);
        }
        if (value.result) parts.push(`本次：${value.result}`);
        return [text(parts.join('\n'))];
      },
    },
    async execute(args) {
      const action = String(args.action ?? 'status');
      let result = '';
      if (action === 'start') {
        observer.start();
        result = '已开启旁观';
      } else if (action === 'pause') {
        observer.pause();
        result = '已暂停旁观';
      } else if (action === 'once') {
        const outcome = await observer.tick({ force: true });
        result = outcome.said
          ? `桌宠说了：${outcome.said}`
          : `没有开口，原因：${outcome.skipped ?? 'unknown'}`;
      }
      const status = observer.status();
      return {
        enabled: Boolean(status.enabled),
        ticks: Number(status.ticks ?? 0),
        intervalMs: Number(status.intervalMs ?? 0),
        lastScene: status.lastScene ?? {},
        lastSaid: status.lastSaid ?? {},
        lastSkip: status.lastSkip ?? {},
        rate: status.rate ?? {},
        action,
        result,
      };
    },
  };

  const sayTool = {
    name: 'companion_say',
    description:
      '让桌宠说一句指定的话（不生成、不调模型），可选同时播一段指定动画。适合把结论、提醒、状态用「宠物开口」的方式交给用户，而不是只在聊天里打字。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: '要桌宠说出来的话，一句话，不超过 120 字。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
      render: (args, value) => [
        text(value.ok ? `桌宠说了：${args.text}` : `没能让桌宠开口：${value.reason}`),
      ],
    },
    async execute(args) {
      const line = String(args.text ?? '').slice(0, 200);
      const spoken = await say(ctx, line);
      if (!spoken.ok) {
        logger?.warn?.(`[dsh-companion-journal] companion_say 失败：${spoken.reason}`);
      }
      return {
        ok: Boolean(spoken.ok),
        reason: spoken.ok ? '' : String(spoken.reason ?? 'unknown'),
      };
    },
  };

  const lastCaptureTool = {
    name: 'companion_last_capture',
    description:
      '【仅在用户明确提到「刚才那个」「我选中的那段」「刚抓的」时才用】读本机最近一次「看一眼」抓到的内容。' +
      '这是**全局**最近一次，可能来自别的会话；不要用它来猜测当前话题的上下文，也不要主动调用它「找资料」。' +
      '如果当前会话的消息里已经带着原文或截图，就不要调用。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          has: { type: 'boolean' },
          via: { type: 'string' },
          appName: { type: 'string' },
          windowTitle: { type: 'string' },
          text: { type: 'string' },
          ageSeconds: { type: 'number' },
          note: { type: 'string' },
        },
      },
      render: (args, value) => [
        text(
          value.has
            ? `最近一次抓取（${value.via === 'selection' ? '选中文字' : '窗口截图'}）：` +
              `${value.appName || '未知应用'}${value.windowTitle ? `「${value.windowTitle}」` : ''}，` +
              `${value.ageSeconds} 秒前。
${value.text || ''}`
            : value.note ?? '还没有抓取记录',
        ),
      ],
    },
    async execute() {
      const latest = readLastCapture();
      if (!latest) {
        return { has: false, via: '', appName: '', windowTitle: '', text: '', note: '还没抓过：先按热键看一眼。' };
      }
      return {
        has: true,
        via: String(latest.via ?? ''),
        appName: String(latest.appName ?? ''),
        windowTitle: String(latest.windowTitle ?? ''),
        text: String(latest.text ?? ''),
        ageSeconds: Math.max(0, Math.round((Date.now() - Number(latest.at ?? Date.now())) / 1000)),
      };
    },
  };

  // 只有 macOS 的四个工具带原生桥依赖。非 macOS 上仍然保留 companion_say
  // ——它只是把一句话写进浮窗的气泡，跟操作系统无关。
  // 宁可少注册四个工具，也不要注册一堆「一调就报看不懂的错」的工具。
  const nativeTools = [windowsTool, readTool, captureTool, watchTool];
  return process.platform === 'darwin' ? [...nativeTools, sayTool, lastCaptureTool] : [sayTool];
}
