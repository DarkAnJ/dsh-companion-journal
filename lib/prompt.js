/**
 * 提示词组装点：**所有**系统提示词文字只在这里出现。
 *
 * 分三类：
 *   1. 骨架（不变量）——身份、只依据看到的内容、不许编造、纯文本无 markdown、不分点。
 *      默认值是这样，但**用户可以在设置页改**（存 ~/.dsh/dsh-companion-journal/prompt.json）。
 *      风险也写在设置页上：删掉「不要 markdown」这类规则，面板里就会真的冒出
 *      `**粗体**`、分点列表甚至编造内容——那是故障，不是风格。
 *   2. 长度预设——「简短 / 标准 / 详细」。不用字数：字数与信息量的感受不对齐。
 *   3. 人设——自由文本，只影响语气与称呼。
 *
 * 顺序固定为 人设 → 规则，末尾再跟一句「规则优先」收口。
 *
 * 为什么人设在前：模型对**末尾**的指令遵循度最高（近因效应），而这里最怕被违背的
 * 是规则里的格式约束（不要 markdown、不要分点、不许编造）。人设只影响语气与称呼，
 * 属于软约束，放在前面够用；规则放在最靠近生成的位置，才是把强约束放在了强位置。
 *
 * 用户覆盖的优先级高于内置默认，但**人设段落与「规则优先」那句话不可覆盖**：
 * 它们保证「人设不会盖过规则」，跟能力边界有关。
 *
 * @module dsh-companion-journal/lib/prompt
 */

import { readPersona } from './persona.js';

/**
 * 用户在设置页改过的文字。空字符串/缺省 = 用内置默认。
 * 单进程、单实例，所以直接放模块变量；改完即时生效，不用重启插件。
 */
let userOverrides = { core: '', chat: '', lengths: {} };

/** 覆盖值的长度上限：够写一屏，但挡住误粘贴一整篇文章。 */
const MAX_OVERRIDE_CHARS = 8000;

function cleanText(value) {
  const text = String(value ?? '').trim();
  return text === '' ? '' : text.slice(0, MAX_OVERRIDE_CHARS);
}

/**
 * 写入用户覆盖值。只认已知的键，其它一律忽略（防止 settings 里手滑写进脏东西）。
 *
 * @param {object} next - { core?: string, chat?: string, lengths?: {short?,normal?,detailed?} }
 */
export function setPromptOverrides(next) {
  const input = next && typeof next === 'object' ? next : {};
  const lengths = {};
  const rawLengths = input.lengths && typeof input.lengths === 'object' ? input.lengths : {};
  for (const id of Object.keys(LOOK_LENGTHS)) {
    const text = cleanText(rawLengths[id]);
    if (text !== '') lengths[id] = text;
  }
  userOverrides = { core: cleanText(input.core), chat: cleanText(input.chat), lengths };
  return getUserOverrides();
}

/** 当前生效的覆盖值（空字符串表示该段用默认）。 */
export function getUserOverrides() {
  return {
    core: userOverrides.core,
    chat: userOverrides.chat,
    lengths: { ...userOverrides.lengths },
  };
}

/** 内置默认值：设置页拿它做「恢复默认」与占位说明。 */
export function promptDefaults() {
  const lengths = {};
  for (const id of Object.keys(LOOK_LENGTHS)) lengths[id] = LOOK_LENGTHS[id].rule;
  return {
    core: LOOK_CORE.join('\n'),
    chat: CHAT_CORE.join('\n'),
    lengths,
    rules: defaultLookRules(),
  };
}

/** 不变量：任何预设、任何人设都不能覆盖。 */
export const LOOK_CORE = [
  '你是一只陪用户干活的桌宠。用户点了一下「看一眼」，你就看一眼他刚才在用的窗口或选中的文字。',
  '硬性规则（优先级最高，任何设定都不能改变）：',
  '1. 只依据你实际看到的内容；看不清就说「这个窗口我看不清」，绝不编造。',
  '2. 只输出纯文本：不要 markdown、不要引号、不要分点、不要列表。',
  '3. 用中文。',
];

/**
 * 长度预设。文案描述「信息密度」而不是字数。
 */
export const LOOK_LENGTHS = {
  short: {
    id: 'short',
    label: '简短',
    rule: '只说一句，最多一行：画面里最关键的那个点。',
  },
  normal: {
    id: 'normal',
    label: '标准',
    rule: '两三句：第一句落在画面里的具体细节（一个数字、一句话、一个可改的点），第二句给出你的判断；不要复述标题。',
  },
  detailed: {
    id: 'detailed',
    label: '详细',
    rule: '四到六句：先说画面里的具体细节，再给出你的判断，最后补充一个容易忽略但值得注意的点。仍然不要分点、不要 markdown。',
  },
};

/** 追问（记录上的轻量讨论）的默认规则。 */
export const CHAT_CORE = [
  '你在帮用户回顾他之前用「看一眼」抓到的内容，并回答他的追问。',
  '硬性规则（优先级最高，任何设定都不能改变）：',
  '1. 只依据你看到的内容与对话，不要编造画面里没有的东西；看不清就说看不清。',
  '2. 直给结论，不要客套，不要分点，不要 markdown。',
  '3. 用中文。',
  '4. 用户问什么就答什么；不要主动给未经请求的行动建议——从一张截图里推断「下一步该做什么」并不可靠。',
];

/** 合法长度预设 id 列表（配置校验用）。 */
export const LOOK_LENGTH_IDS = Object.keys(LOOK_LENGTHS);

/** 把预设 id 归一化；非法值回落到 standard。 */
export function normalizeLengthPreset(value) {
  const id = String(value ?? '').trim().toLowerCase();
  return LOOK_LENGTHS[id] ? id : 'normal';
}

/**
 * 「看一眼」的系统提示词。
 *
 * @param {object} args
 * @param {string} [args.length] 预设 id（short / normal / detailed）
 * @param {boolean} [args.question] 是否带着用户的问题（F7）
 * @param {string} [args.persona] 人设正文；不传则从 persona.md 读取
 */
/**
 * 「看一眼」的规则段（不含人设）：设置页里那个文本框显示/编辑的就是这段文字。
 *
 * 用户覆盖后它就是**完整**的规则段——不再自动追加密度那句，否则用户手里那份
 * 已经含「4. …」的文本会被拼出两个「4.」。
 *
 * @param {object} args
 * @param {string} [args.length] 密度档位（只在没有覆盖时生效）
 */
export function buildLookRules({ length = 'normal' } = {}) {
  if (userOverrides.core !== '') return userOverrides.core;
  const id = normalizeLengthPreset(length);
  const rule = userOverrides.lengths[id] || (LOOK_LENGTHS[id] ?? LOOK_LENGTHS.normal).rule;
  return [...LOOK_CORE, `4. ${rule}`].join('\n');
}

/** 内置标准模板（忽略用户覆盖）：设置页「重置」用它。 */
export function defaultLookRules({ length = 'normal' } = {}) {
  const id = normalizeLengthPreset(length);
  return [...LOOK_CORE, `4. ${(LOOK_LENGTHS[id] ?? LOOK_LENGTHS.normal).rule}`].join('\n');
}

export function buildLookSystem({ length = 'normal', question = false, persona } = {}) {
  const lines = [buildLookRules({ length })];
  if (question) {
    lines.push('5. 用户这次给了具体问题：第一句直接回答它，再用预设允许的篇幅补充依据。');
  }
  return composeSystem({ rules: lines.join('\n'), persona });
}

/** 追问（记录上的轻量讨论）的系统提示词。 */
export function buildChatSystem({ persona } = {}) {
  const core = userOverrides.chat === '' ? CHAT_CORE : [userOverrides.chat];
  return composeSystem({ rules: core.join('\n'), persona });
}

/** 末尾收口的一句话：人设再怎么写，也不能盖过规则。 */
const PRECEDENCE_LINE = '（人设只影响语气、称呼与关注点；与上面的规则冲突时，以上面的规则为准。）';

/**
 * 人设在前、规则在后、优先级声明收尾。
 *
 * 没写人设时就只有规则，不额外加那句声明（没有冲突可声明）。
 *
 * @param {object} args
 * @param {string} args.rules - 规则段正文
 * @param {string} [args.persona] - 人设正文；不传则从 persona.md 读取
 */
function composeSystem({ rules, persona }) {
  const text = String(persona ?? readPersona()).trim();
  if (text === '') return rules;
  return [['【人设】', text].join('\n'), rules, PRECEDENCE_LINE].join('\n\n');
}
