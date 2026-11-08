/**
 * 人设读写：纯文件操作，不碰模型。
 *
 *   node test/persona.test.js
 *
 * @module dsh-companion-journal/test/persona
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { personaBlock, personaPath, readPersona } from '../lib/persona.js';

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

const dir = mkdtempSync(join(tmpdir(), 'dsh-persona-'));

check('没有人设文件时返回空串（= 中性语气）', () => {
  eq(readPersona(dir), '');
  eq(personaBlock(dir), '');
});

check('读取并拼进提示词，规则优先那句必须在', () => {
  writeFileSync(personaPath(dir), '  你是一只话不多的搭子，叫我老周。  ');
  eq(readPersona(dir), '你是一只话不多的搭子，叫我老周。');
  const block = personaBlock(dir);
  ok(block.includes('【人设】'), block);
  ok(block.includes('老周'), block);
  ok(block.includes('规则优先'), '必须写明规则优先，否则人设可能覆盖「不许编造」');
});

check('长文本截断到 4000 字以内', () => {
  writeFileSync(personaPath(dir), '猫'.repeat(5000));
  ok(readPersona(dir).length <= 4000, '应截断');
});

check('修改后按 mtime 重新读取', () => {
  writeFileSync(personaPath(dir), '第一版');
  eq(readPersona(dir), '第一版');
  writeFileSync(personaPath(dir), '第二版');
  eq(readPersona(dir), '第二版');
});

rmSync(dir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`✗ persona ${failures.length} 项失败：`);
  for (const failure of failures) console.error('  - ' + failure);
  process.exitCode = 1;
} else {
  console.log(`✓ persona ${passed} 项全过`);
}
