/**
 * 身份一致性测试：包名、bundle id、客户端 id、HTTP 路由、数据目录必须同名。
 *
 * 改名是分发里最容易漏的一类：宿主半侧换了、客户端半侧没换，页面就静默
 * 404；包名换了、patch id 没换，市场预检与 patch 覆盖都定位不到这一行。
 *
 *   node test/identity.test.js
 *
 * @module dsh-companion-journal/test/identity
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
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

async function main() {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const name = manifest.name;
  const client = await readFile(join(ROOT, 'lib/client.js'), 'utf8');
  const host = await readFile(join(ROOT, 'lib/index.js'), 'utf8');
  const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8');

  await check('包名与 patch id/name 一致', () => {
    eq(/(?:^|\n)\s*- id:\s*(\S+)/.exec(patch)?.[1], name);
    eq(/name:\s*['"]?([^'"\s]+)['"]?/.exec(patch)?.[1], name);
  });

  await check('客户端 ModuleLoader id 与包名一致', () => {
    const id = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(client)?.[1];
    eq(id, name);
  });

  await check('宿主与客户端的 HTTP 路由前缀一致', () => {
    const hostRoute = /const ROUTE_SEGMENT = '([^']+)'/.exec(host)?.[1];
    ok(hostRoute, '缺少 ROUTE_SEGMENT');
    ok(client.includes(`'${hostRoute}/`), '客户端没有使用同一个路由前缀');
  });

  await check('lib/ 里旧包名只剩迁移与 localStorage 回退', async () => {
    const files = (await readdir(join(ROOT, 'lib'))).filter((file) => file.endsWith('.js'));
    const offenders = [];
    for (const file of files) {
      const text = await readFile(join(ROOT, 'lib', file), 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, index) => {
        if (!/dsh-companion(?!-journal)/.test(line)) return;
        if (file === 'migrate.js') return;
        if (file === 'client.js' && line.includes("getItem('dsh-companion.preset')")) return;
        offenders.push(`${file}:${index + 1}`);
      });
    }
    eq(offenders.join(','), '', '还有未迁移的旧标识');
  });

  if (failures.length > 0) {
    console.error(`✗ ${failures.length} 项失败（通过 ${passed} 项）`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`✓ identity 身份 ${passed} 项全过`);
}

main().catch((error) => {
  console.error(`✗ 测试崩了：${String(error?.stack ?? error)}`);
  process.exit(1);
});
