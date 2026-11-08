/**
 * 人设（persona）：一段纯文本，拼进「看一眼」与「追问」的系统提示词。
 *
 * 为什么放文件而不是配置项：人设是长文本、会反复改，放在 `~/.dsh/dsh-companion-journal/persona.md`
 * 里既能在设置页编辑，也能直接用编辑器改、进版本库。
 *
 * 约束：人设只影响**语气与称呼**，不覆盖任务规则（规则优先），否则用户写一句
 * 「你是猫」就可能把「不要编造」冲掉。
 *
 * @module dsh-companion-journal/lib/persona
 */

import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 缓存：按 mtime 失效，避免每句话都读盘。 */
let cache = { text: '', mtimeMs: -1, path: '' };

/** 运行时目录：`$DSH_HOME/dsh-companion-journal`（与浮窗文件同一处）。 */
export function defaultBaseDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'dsh-companion-journal');
}

/** 人设文件路径（与其它运行时文件放一起）。 */
export function personaPath(baseDir = defaultBaseDir()) {
  return join(baseDir, 'persona.md');
}

/**
 * 读取人设正文。
 * @returns {string} 去掉首尾空白；不存在时返回空串（= 中性语气）。
 */
export function readPersona(baseDir = defaultBaseDir()) {
  const path = personaPath(baseDir);
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    cache = { text: '', mtimeMs: -1, path };
    return '';
  }
  if (cache.path === path && cache.mtimeMs === mtimeMs) return cache.text;
  try {
    const text = readFileSync(path, 'utf8').slice(0, 4000).trim();
    cache = { text, mtimeMs, path };
    return text;
  } catch {
    return '';
  }
}

/**
 * 拼成可直接追加到系统提示词的片段；没有人设时返回空串。
 *
 * 明确写「规则优先」：用户可能写很有个性的人设，但「不许编造 / 看不清就说看不清」
 * 这类规则不能被覆盖。
 */
export function personaBlock(baseDir = defaultBaseDir()) {
  const text = readPersona(baseDir);
  if (text === '') return '';
  return [
    '',
    '【人设】',
    text,
    '',
    '（以上人设只影响语气、称呼与关注点。**输出长度仍遵守上面的规则**——不要因为人设要求'
      + '「详细」「展开说」就变长；与规则冲突时，规则优先。）',
  ].join('\n');
}
