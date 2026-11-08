/**
 * 分发测试：模拟「别人从 GitHub / npm 装到这个包」时**实际拿到什么**。
 *
 * 为什么要有这一条：本地能跑不等于别人能装。`files` 少写一条，产物就少一个
 * 运行时文件，而症状是「别人那里插件加载了但截图一直失败」——在本机永远复现
 * 不出来。这里不再自己猜 npm 的 files 规则，而是真的跑一次 `npm pack`，
 * 把生成的 tarball 解到**带空格的路径**里，再从那里加载插件。
 *
 *   node test/pack.test.js
 *
 * @module dsh-companion-journal/test/pack
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { runProcess } from '../lib/native.js';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// 装好的包也会 apply()：不拉真浮窗、不动本机历史目录。
process.env.DSH_COMPANION_NO_BUDDY = '1';
process.env.DSH_COMPANION_NO_MIGRATE = '1';

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

/** 跑 npm pack 并返回 `{ tarball, files }`；缓存放到临时目录，绕开本机 npm 缓存权限问题。 */
async function pack(destination, cache) {
  const { stdout } = await run(
    'npm',
    ['pack', '--json', '--pack-destination', destination],
    { cwd: ROOT, env: { ...process.env, npm_config_cache: cache }, maxBuffer: 32 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout);
  const entry = Array.isArray(parsed) ? parsed.at(-1) : parsed;
  if (!entry?.filename) throw new Error('npm pack 没有返回 tarball 文件名');
  return { tarball: join(destination, entry.filename), files: entry.files ?? [] };
}

/** 从 tarball 里读出 UTF-8 文件（不依赖解包，用于检查元数据）。 */
async function readFromTarball(tarball, relative) {
  const { stdout } = await run('tar', ['-xOzf', tarball, `package/${relative}`], { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function main() {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

  await check('package.json 不是 private（否则发不了 npm）', () => {
    ok(manifest.private !== true, 'private 必须去掉');
  });

  await check('声明了 license、repository、author', () => {
    eq(manifest.license, 'MIT');
    ok(manifest.repository?.url, '缺 repository.url');
    ok(manifest.author, '缺 author');
  });

  await check('repository / homepage / bugs 指向真实仓库，没有 USER 占位符', () => {
    const text = [manifest.repository?.url, manifest.homepage, manifest.bugs?.url].join(' ');
    ok(!text.includes('USER'), '仍有 USER 占位符');
    ok(text.includes('DarkAnJ/dsh-companion-journal'), '仓库地址不对');
  });

  await check('声明了 DSH 兼容范围', () => {
    eq(manifest.engines?.dsh, '>=0.2.2-rc.1 <0.3.0');
  });

  await check('bundle 只声明 macOS，patch 文件存在', async () => {
    ok(manifest.dsh?.bundle?.patch, '缺 dsh.bundle.patch');
    ok(existsSync(join(ROOT, manifest.dsh.bundle.patch)), 'patch 文件不存在');
    eq(JSON.stringify(manifest.dsh.bundle.platforms), JSON.stringify(['darwin']));
  });

  await check('cordis.patch.yml 的 id / name 与包名一致', async () => {
    const text = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8');
    const id = /- id:\s*(\S+)/.exec(text)?.[1];
    const name = /name:\s*['"]?([^'"\s]+)['"]?/.exec(text)?.[1];
    eq(id, manifest.name);
    eq(name, manifest.name);
  });

  // ── 真的打一次包 ──────────────────────────────────────────────────────────
  const stage = await mkdtemp(join(tmpdir(), 'dsh companion pack '));
  const cache = join(stage, 'npm-cache');
  try {
    const packed = await pack(stage, cache);

    await check('tarball 只包含运行必需文件，不泄漏 test / .build', () => {
      const files = packed.files.map((file) => file.path);
      const leaked = files.filter((file) => file.startsWith('test/') || file.startsWith('.build/'));
      eq(leaked.join(','), '');
    });

    await check('tarball 含两个原生二进制、立绘、客户端与迁移模块', () => {
      const files = new Set(packed.files.map((file) => file.path));
      const required = [
        'bridge/bin/dsh-bridge',
        'buddy/bin/dsh-buddy',
        'assets/buddy/character.png',
        'lib/client.js',
        'lib/index.js',
        'lib/migrate.js',
        'cordis.patch.yml',
        'locale/zh.json',
        'package.json',
      ];
      const missing = required.filter((file) => !files.has(file));
      if (missing.length > 0) throw new Error(`tarball 漏了：${missing.join(', ')}`);
    });

    await check('发布包里的 package.json 仍是改名后的身份', async () => {
      const text = await readFromTarball(packed.tarball, 'package.json');
      const inner = JSON.parse(text);
      eq(inner.name, 'dsh-companion-journal');
      eq(inner.version, manifest.version);
    });

    await check('发布包里没有残留本机绝对路径', async () => {
      const leaked = packed.files
        .filter((file) => /\.(js|json|yml|md)$/.test(file.path))
        .filter((file) => file.path.startsWith('lib/') || file.path.endsWith('.json'));
      for (const file of leaked) {
        const text = await readFromTarball(packed.tarball, file.path);
        if (/\/Users\/[^/\s]+\//.test(text)) throw new Error(`${file.path} 写死了本机路径`);
      }
    });

    // 解到带空格的目录：验证 fileURLToPath 修复，而不是只在无空格路径下通过。
    await run('tar', ['-xzf', packed.tarball, '-C', stage]);
    const stageRoot = join(stage, 'package');

    await check('解包后原生桥仍可执行且能跑', async () => {
      const binary = join(stageRoot, 'bridge/bin/dsh-bridge');
      const mode = (await stat(binary)).mode;
      ok((mode & 0o111) !== 0, '执行位丢了');
      const result = await runProcess({}, [binary, 'trust'], { timeoutMs: 8000 });
      eq(result.code, 0, 'trust 应返回 0');
      const parsed = JSON.parse(result.stdout.trim());
      eq(parsed.ok, true);
    });

    await check('从带空格的路径能加载插件并注册 6 个工具', async () => {
      const { apply } = await import(`${stageRoot}/lib/index.js`);
      const tools = [];
      const ctx = {
        logger: { info() {}, warn() {}, error() {} },
        effect: (fn) => fn(),
        tools: {
          register(definition) {
            if (typeof definition?.output?.render !== 'function') {
              throw new TypeError(`tool ${definition?.name} 缺 output.render`);
            }
            tools.push(definition);
            return () => {};
          },
        },
        commands: { register: () => () => {} },
        webServer: { port: 1, getOrigin: () => 'http://127.0.0.1:1', register: () => () => {} },
        get: () => undefined,
      };
      const previousHome = process.env.DSH_HOME;
      process.env.DSH_HOME = join(stage, 'dsh-home');
      try {
        apply(ctx, { observe: { enabled: false } });
      } finally {
        if (previousHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = previousHome;
      }
      eq(tools.length, 6, '应注册 6 个工具');
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`✗ ${failures.length} 项失败（通过 ${passed} 项）`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`✓ pack 分发 ${passed} 项全过（真实 npm pack）`);
}

main().catch((error) => {
  console.error(`✗ 测试崩了：${String(error?.stack ?? error)}`);
  process.exit(1);
});
