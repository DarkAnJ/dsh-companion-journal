/**
 * 输出面：把「桌宠说话」抽象出来。
 *
 * 现在只有一个实现（自绘浮窗 `dsh-buddy`），但调用方（lookOnce、observer、工具）
 * 只认这个模块的函数签名——将来换成别的渲染方式，上层不用改。
 *
 * @module dsh-companion-journal/lib/surface
 */

import { sayBubble, buddyState } from './buddy.js';

/** 浮窗的 say 文件路径，由 apply() 在启动浮窗时注入。 */
let paths = null;

/** 注入输出路径（插件启动时调用一次）。 */
export function setSurface(pathsInjected) {
  paths = pathsInjected ?? null;
}

/** 当前是否接了输出面（浮窗没起来时返回 false，调用方据此降级）。 */
export function surfaceReady() {
  return Boolean(paths) && buddyState.running;
}

/**
 * 让桌宠说一句话。签名与旧的 pet.say 保持一致，方便逐处替换。
 *
 * @param _ctx - 未使用，保留旧调用签名
 * @param text - 要说的话
 * @param options.recordId - 关联的记录 id（点气泡时打开它）
 */
export async function say(_ctx, text, { recordId = '', compact = false, bold = false, sticky = false, actions, top = '' } = {}) {
  if (!paths) return { ok: false, reason: 'surface-unavailable' };
  const result = sayBubble(paths, text, { recordId, compact, bold, sticky, actions, top });
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

/** 静态形象没有动画；保留签名，调用方不必判空。 */
export async function playAnim() {
  return { ok: false, reason: 'static-surface' };
}
