/**
 * 提示词组装：不变量必须永远在，预设只改密度，人设只加语气。
 *
 *   node test/prompt.test.js
 *
 * @module dsh-companion-journal/test/prompt
 */

import {
  buildChatSystem,
  buildLookRules,
  buildLookSystem,
  defaultLookRules,
  getUserOverrides,
  LOOK_LENGTH_IDS,
  normalizeLengthPreset,
  promptDefaults,
  setPromptOverrides,
} from '../lib/prompt.js';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
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

function notIncludes(text, needle, label = '') {
  if (text.includes(needle)) throw new Error(`${label} 不该包含 ${needle}`);
}

check('三种预设都存在，且文案各不相同', () => {
  eq(LOOK_LENGTH_IDS.join(','), 'short,normal,detailed');
  const texts = LOOK_LENGTH_IDS.map((id) => buildLookSystem({ length: id, persona: '' }));
  eq(new Set(texts).size, 3, '三种预设必须产生不同提示词');
});

check('不变量永远在：不编造、纯文本、中文', () => {
  for (const id of LOOK_LENGTH_IDS) {
    const text = buildLookSystem({ length: id, persona: '你是猫。' });
    ok(text.includes('绝不编造'), id);
    ok(text.includes('不要 markdown'), id);
    ok(text.includes('用中文'), id);
  }
});

check('非法预设回落 standard', () => {
  eq(normalizeLengthPreset('nonsense'), 'normal');
  eq(normalizeLengthPreset('SHORT'), 'short');
  eq(normalizeLengthPreset(undefined), 'normal');
});

check('不再出现「下一步建议」这类指令', () => {
  const look = buildLookSystem({ length: 'normal', persona: '' });
  const chat = buildChatSystem({ persona: '' });
  // 「看一眼」里不该出现任何「给下一步」的指令
  notIncludes(look, '下一步', '看一眼提示词');
  notIncludes(look, '可以接着做', '看一眼提示词');
  notIncludes(look, '建议', '看一眼提示词');
  // 追问里保留「不主动给建议」这条**禁止**，而不是要求给建议
  ok(chat.includes('不要主动给未经请求的行动建议'), '追问里要明确不主动给建议');
});

check('人设在前、规则在后，末尾声明规则优先', () => {
  const text = buildLookSystem({ length: 'normal', persona: '叫我老周。' });
  const personaAt = text.indexOf('叫我老周');
  const rulesAt = text.indexOf('绝不编造');
  const precedenceAt = text.indexOf('规则为准');
  ok(personaAt >= 0 && rulesAt >= 0 && precedenceAt >= 0, text);
  ok(personaAt < rulesAt, '人设应在前（规则放末尾，近因效应更稳）');
  ok(rulesAt < precedenceAt, '规则后面应跟一句优先级声明');
  ok(!text.includes('硬性规则优先'), '旧措辞应已替换');
});

check('F7（带问题）会多一条指令', () => {
  const without = buildLookSystem({ length: 'normal', persona: '', question: false });
  const withQ = buildLookSystem({ length: 'normal', persona: '', question: true });
  ok(withQ.length > without.length);
  ok(withQ.includes('用户这次给了具体问题'), withQ);
});

// ── 设置页可覆盖的部分（v0.38.0）────────────────────────────────────────────

check('设置页能覆盖规则；清空后回到默认', () => {
  try {
    setPromptOverrides({ core: '你是测试用的桌宠。只回答「好」。' });
    const text = buildLookSystem({ length: 'normal', persona: '' });
    ok(text.includes('你是测试用的桌宠'), text);
    ok(!text.includes('绝不编造'), '覆盖后不该再拼内置规则');
    eq(getUserOverrides().core, '你是测试用的桌宠。只回答「好」。');
  } finally {
    setPromptOverrides({});
  }
  const back = buildLookSystem({ length: 'normal', persona: '' });
  ok(back.includes('绝不编造'), '清空后应回到内置规则');
  eq(getUserOverrides().core, '');
});

check('覆盖规则段后不再追加密度行（不会出现两个「4.」）', () => {
  try {
    setPromptOverrides({ core: '自定义规则。\n4. 自定义密度。' });
    const text = buildLookSystem({ length: 'normal', persona: '' });
    eq((text.match(/^4\. /gm) ?? []).length, 1, '只应有一个「4.」行');
    ok(text.includes('自定义密度'), text);
    ok(!text.includes('两三句'), '覆盖后不该再拼内置密度文案');
    eq(getUserOverrides().core, '自定义规则。\n4. 自定义密度。');
  } finally {
    setPromptOverrides({});
  }
});

check('默认模板与「重置」用的文本不受覆盖影响', () => {
  try {
    setPromptOverrides({ core: '随便写点。' });
    const def = defaultLookRules();
    ok(def.includes('绝不编造'), '默认模板应始终是内置规则');
    ok(def.includes('4. '), '默认模板应包含密度那一行');
    eq(buildLookRules(), '随便写点。', '当前生效的规则段应是覆盖值');
  } finally {
    setPromptOverrides({});
  }
  eq(buildLookRules(), defaultLookRules(), '清空后应回到默认模板');
});

check('覆盖某一档密度只影响那一档', () => {
  try {
    setPromptOverrides({ lengths: { short: '只吐一个字。' } });
    const short = buildLookSystem({ length: 'short', persona: '' });
    const normal = buildLookSystem({ length: 'normal', persona: '' });
    ok(short.includes('只吐一个字'), short);
    ok(!short.includes('只说一句，最多一行'), '被覆盖的档位不该再出现默认文案');
    ok(normal.includes('两三句'), '其它档位应保持默认');
  } finally {
    setPromptOverrides({});
  }
});

check('追问规则可覆盖，但「人设不压规则」那句仍在', () => {
  try {
    setPromptOverrides({ chat: '你是测试用的追问助手。' });
    const chat = buildChatSystem({ persona: '叫我老周。' });
    ok(chat.includes('你是测试用的追问助手'), chat);
    ok(!chat.includes('不要主动给未经请求的行动建议'), '覆盖后默认规则应消失');
    ok(chat.includes('规则为准'), '末尾的优先级声明不可被覆盖');
  } finally {
    setPromptOverrides({});
  }
});

check('覆盖值长度被截断，且只认已知档位', () => {
  try {
    const long = 'x'.repeat(20000);
    setPromptOverrides({ core: long, lengths: { nope: '不该出现' } });
    ok(getUserOverrides().core.length <= 8000, '覆盖值应有长度上限');
    eq(Object.keys(getUserOverrides().lengths).join(','), '', '未知档位应被忽略');
    const defaults = promptDefaults();
    ok(defaults.core.includes('绝不编造'), '默认值仍然可取到');
  } finally {
    setPromptOverrides({});
  }
});

if (failures.length > 0) {
  console.error(`✗ prompt ${failures.length} 项失败：`);
  for (const failure of failures) console.error('  - ' + failure);
  process.exitCode = 1;
} else {
  console.log(`✓ prompt ${passed} 项全过`);
}
