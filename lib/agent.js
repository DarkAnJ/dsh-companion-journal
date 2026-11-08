/**
 * 与宿主 agent 的接缝：把截图变成模型能看的内容块。
 *
 * 这里做的每一步都是**可失败的**，而且失败要能解释：
 *   - 宿主没挂附件服务（部署裁剪过）
 *   - 拿不到当前模型路由（会话还没定模型）
 *   - 模型不声明 image 输入（纯文本模型）
 * 三种情况下截图依然存在，只是没法给模型看 —— 那就退回「文字描述 + 说明」，
 * 绝不能假装附上了。假装附图会让模型对着空气点评，这是最坏的一种错。
 *
 * @module dsh-companion-journal/lib/agent
 */

/** 一个文本内容块。 */
export function textBlock(text) {
  return { type: 'text', text: String(text ?? '') };
}

/** 解析当前 agent 用的模型路由；解析不到返回 null。 */
function resolveRoute(exec) {
  try {
    const routed = exec?.agent?.session?.requestHeader?.()?.config;
    const provider = routed?.provider ?? exec?.agent?.options?.provider;
    const model = routed?.model ?? exec?.agent?.options?.model;
    if (!provider || !model) return null;
    return { provider, model };
  } catch {
    return null;
  }
}

/**
 * 尝试把图片字节存成持久附件并返回 image 内容块。
 * @returns {Promise<{block:object}|{reason:string}>}
 */
export async function attachImage(ctx, exec, bytes, mediaType = 'image/png', name = 'screenshot.png') {
  if (!bytes || bytes.length === 0) return { reason: '图片字节为空' };

  const attachments = ctx?.get?.('attachments');
  if (!attachments || typeof attachments.saveImages !== 'function') {
    return { reason: '宿主没有挂载附件服务（dsh-attachment-local）' };
  }

  const route = resolveRoute(exec);
  if (!route) return { reason: '拿不到当前会话的模型路由' };

  const llm = ctx?.get?.('llm');
  if (!llm || typeof llm.resolveModelInfo !== 'function') {
    return { reason: '宿主没有挂载模型服务（dsh-llm）' };
  }

  let info;
  try {
    info = await llm.resolveModelInfo(route.provider, route.model, exec?.signal);
  } catch (error) {
    return { reason: `模型能力查询失败：${String(error?.message ?? error)}` };
  }
  const modalities = info?.inputModalities;
  if (!Array.isArray(modalities) || !modalities.includes('image')) {
    return { reason: `模型 ${route.model} 没有声明图片输入` };
  }

  try {
    const refs = await attachments.saveImages([
      { data: new Uint8Array(bytes), mediaType, name },
    ]);
    const ref = Array.isArray(refs) ? refs[0] : refs;
    if (!ref) return { reason: '附件服务没有返回引用' };
    return { block: { type: 'image', attachment: ref } };
  } catch (error) {
    return { reason: `附件保存被拒：${String(error?.message ?? error)}` };
  }
}

/**
 * 让桌宠的说法与模型看到的内容保持一致：
 * 有图就附图，没图就把原因写进文本，别让模型以为看过了。
 */
export function composeCaptureContent({ summary, attached, failureReason }) {
  const content = [textBlock(summary)];
  if (attached) {
    content.push(attached);
    return content;
  }
  content.push(
    textBlock(
      `（这张图没能作为图片附上：${failureReason ?? '未知原因'}。` +
        '请改为依据窗口文本回答，或请用户把截图直接贴进对话。）',
    ),
  );
  return content;
}
