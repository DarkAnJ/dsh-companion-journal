/**
 * 旧目录迁移测试：`~/.dsh/dsh-companion/` → `~/.dsh/dsh-companion-journal/`。
 *
 * 这条测试存在的原因：改名最贵的错误不是起不来，而是「起得来但历史没了」。
 * 这里用临时 HOME 真跑一次迁移，钉住目录内容、符号链接与重复启动的幂等性。
 *
 *   node test/migrate.test.js
 *
 * @module dsh-companion-journal/test/migrate
 */

import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DATA_DIR_NAME, LEGACY_DATA_DIR_NAME, dataDir, legacyDataDir, migrateLegacyDataDir } from '../lib/migrate.js';

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
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

const silent = { info() {}, warn() {} };

async function withHome(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-companion-migrate-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    await fn(root);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function seedLegacy(root) {
  const legacy = join(root, LEGACY_DATA_DIR_NAME);
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'history.jsonl'), '{"id":"old"}\n', 'utf8');
  await mkdir(join(legacy, 'assets'), { recursive: true });
  await writeFile(join(legacy, 'assets', 'character.png'), 'png', 'utf8');
  await writeFile(join(legacy, 'persona.md'), '旧人设', 'utf8');
  return legacy;
}

async function main() {
  await check('路径常量与包名一致', () => {
    eq(DATA_DIR_NAME, 'dsh-companion-journal');
    eq(LEGACY_DATA_DIR_NAME, 'dsh-companion');
  });

  await check('旧目录存在时整体迁移，并保留旧路径符号链接', async () => {
    await withHome(async (root) => {
      const legacy = await seedLegacy(root);
      const target = join(root, DATA_DIR_NAME);

      const result = migrateLegacyDataDir(silent);
      eq(result.migrated, true, '应报告 migrated');
      ok(existsSync(target), '新目录应存在');
      eq(await readFile(join(target, 'history.jsonl'), 'utf8'), '{"id":"old"}\n');
      eq(await readFile(join(target, 'persona.md'), 'utf8'), '旧人设');
      ok(existsSync(join(target, 'assets', 'character.png')), '立绘缓存应一起迁移');

      let link = '';
      try {
        link = await readlink(legacy);
      } catch {
        link = '';
      }
      ok(link !== '', '旧路径应保留符号链接（快捷指令写死了旧路径）');
    });
  });

  await check('重复启动幂等，不会报错也不会重复搬', async () => {
    await withHome(async (root) => {
      await seedLegacy(root);
      migrateLegacyDataDir(silent);
      const second = migrateLegacyDataDir(silent);
      eq(second.migrated, false, '第二次不应再迁移');
      eq(second.reason, 'already-linked');
    });
  });

  await check('新旧目录同时存在时保留旧数据，不覆盖', async () => {
    await withHome(async (root) => {
      const legacy = await seedLegacy(root);
      const target = join(root, DATA_DIR_NAME);
      await mkdir(target, { recursive: true });
      await writeFile(join(target, 'history.jsonl'), '{"id":"new"}\n', 'utf8');

      const result = migrateLegacyDataDir(silent);
      eq(result.migrated, false, '不应迁移');
      eq(result.reason, 'target-exists');
      eq(await readFile(join(target, 'history.jsonl'), 'utf8'), '{"id":"new"}\n');
      eq(await readFile(join(legacy, 'history.jsonl'), 'utf8'), '{"id":"old"}\n');
    });
  });

  await check('没有旧目录时是空操作', async () => {
    await withHome(async () => {
      const result = migrateLegacyDataDir(silent);
      eq(result.reason, 'no-legacy');
      eq(result.migrated, false);
    });
  });

  await check('apply() 会先迁移再创建运行时目录', async () => {
    await withHome(async (root) => {
      const legacy = await seedLegacy(root);
      process.env.DSH_COMPANION_NO_BUDDY = '1';
      const { apply } = await import('../lib/index.js');
      const ctx = {
        logger: silent,
        effect: (fn) => fn(),
        tools: { register: () => () => {} },
        commands: { register: () => () => {} },
        webServer: { port: 1, getOrigin: () => 'http://127.0.0.1:1', register: () => () => {} },
        get: () => undefined,
      };
      apply(ctx, { observe: { enabled: false } });
      ok(existsSync(join(root, DATA_DIR_NAME, 'history.jsonl')), '迁移应在 apply 期间发生');
      ok(lstatSync(legacy).isSymbolicLink(), '旧路径应变成指向新目录的符号链接');
      eq(await readFile(join(legacy, 'history.jsonl'), 'utf8'), '{"id":"old"}\n', '旧路径仍应能读到历史');
    });
  });

  if (failures.length > 0) {
    console.error(`✗ ${failures.length} 项失败（通过 ${passed} 项）`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`✓ migrate 迁移 ${passed} 项全过`);
}

main().catch((error) => {
  console.error(`✗ 测试崩了：${String(error?.stack ?? error)}`);
  process.exit(1);
});
