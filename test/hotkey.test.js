/**
 * 热键解析与配置：不碰 Electron、不碰系统，纯字符串规则。
 *
 *   node test/hotkey.test.js
 *
 * @module dsh-companion-journal/test/hotkey
 */

import { parseAccelerator } from '../lib/hotkey.js';
import { DEFAULTS, normalizeConfig } from '../lib/config.js';

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

function eq(actual, expected, label = '') {
  if (actual !== expected) throw new Error(`${label} 期望 ${expected}，实际 ${actual}`);
}

function ok(value, label = '') {
  if (!value) throw new Error(`${label} 期望为真`);
}

check('加速键：option+shift+L → Alt+Shift+L', () => {
  const parsed = parseAccelerator('option+shift+L');
  eq(parsed.ok, true);
  eq(parsed.accelerator, 'Alt+Shift+L');
});

check('加速键：别名与大小写都收', () => {
  eq(parseAccelerator('opt+CMD+k').accelerator, 'Alt+Command+K');
  eq(parseAccelerator('Control+f8').accelerator, 'Control+F8');
  eq(parseAccelerator('command+alt+space').accelerator, 'Command+Alt+Space');
});

check('加速键：非法输入给可读原因，不抛', () => {
  eq(parseAccelerator('').ok, false);
  eq(parseAccelerator('hyper+L').ok, false);
  ok(String(parseAccelerator('shift+hyper+X').reason).includes('未知修饰键'));
  ok(String(parseAccelerator('option+€').reason).includes('不支持的键'));
});

check('配置：热键默认开启且可关，写错只告警', () => {
  eq(DEFAULTS.hotkey.enabled, true);
  eq(DEFAULTS.hotkey.spec, 'option+shift+L');
  const off = normalizeConfig({ hotkey: { enabled: false } });
  eq(off.config.hotkey.enabled, false);
  const bad = normalizeConfig({ hotkey: { spec: 42 } });
  eq(bad.config.hotkey.spec, 'option+shift+L');
  ok(bad.warnings.some((w) => w.includes('hotkey.spec')), JSON.stringify(bad.warnings));
});

if (failures.length > 0) {
  console.error(`✗ hotkey ${failures.length} 项失败：`);
  for (const failure of failures) console.error('  - ' + failure);
  process.exitCode = 1;
} else {
  console.log(`✓ hotkey/config ${passed} 项全过`);
}
