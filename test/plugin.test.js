/**
 * 插件契约冒烟测试：用一个假 ctx 把宿主半侧跑起来。
 *
 * 目的不是测业务，而是钉住三件最容易在真实 DSH 里炸掉的事：
 *   1. apply() 不抛异常（抛了会让 DSH 起不来并重写 profile）。
 *   2. 注册出来的工具/命令/路由形状能被注册表接受（缺 output.render 会直接
 *      TypeError，而那个错误只出现在宿主日志里，用户看不到）。
 *   3. 工具真的能跑通系统桥，失败时给的是可操作的话，不是 "unknown error"。
 *
 *   node test/plugin.test.js
 *
 * 其中截图与 Word 两条在某些环境下会拿到权限拒绝 —— 那不是测试失败，
 * 我们断言的是"拒绝时说出去了哪一步、该去点哪个开关"。
 *
 * @module dsh-companion-journal/test/plugin
 */

// 测试里不拉真正的浮窗进程：它会常驻，让 node 永远退不出去。
process.env.DSH_COMPANION_NO_BUDDY = '1';
process.env.DSH_COMPANION_NO_MIGRATE = '1';

let passed = 0;
const failures = [];

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
    })
    .catch((error) => {
      failures.push(`${name}: ${String(error?.message ?? error)}`);
    });
}

function ok(value, label = '') {
  if (!value) throw new Error(`${label} 期望为真`);
}

function eq(actual, expected, label = '') {
  if (actual !== expected) throw new Error(`${label} 期望 ${expected}，实际 ${actual}`);
}

function includes(text, needle, label = '') {
  if (!String(text).includes(needle)) {
    throw new Error(`${label} 期望包含「${needle}」，实际：${String(text).slice(0, 300)}`);
  }
}

/**
 * 模拟 DSH 宿主上下文：只实现本插件真正用到的成员。
 *
 * 关键一条：DSH 的 ctx 是**严格 getter** —— 读一个没写进插件 `inject` 的服务，
 * 拿到的是抛异常，不是 undefined。v0.1.0 装上真机后「HUD 一直连接中、工具和
 * /companion 全没有」就是这个原因，而当时的假 ctx 把三个服务直接挂成属性，
 * 于是测试全绿、真机全废。这里用 getter + injected 白名单把那条规则复刻出来。
 */
function makeCtx({ injected = [] } = {}) {
  const tools = [];
  const commands = [];
  const routes = [];
  const disposers = [];
  const logs = { info: [], warn: [], error: [] };

  const ctx = {
    logger: {
      info: (m) => logs.info.push(String(m)),
      warn: (m) => logs.warn.push(String(m)),
      error: (m) => logs.error.push(String(m)),
    },
    effect(fn) {
      const dispose = fn();
      disposers.push(dispose);
      return dispose;
    },
    tools: {
      register(definition) {
        // 复刻 ToolRuntime.register 的三条硬校验，缺一就会在真实宿主里 TypeError。
        if (typeof definition?.name !== 'string' || definition.name === '') {
          throw new TypeError('tool must declare a name');
        }
        if (!definition.output || typeof definition.output !== 'object') {
          throw new TypeError(`tool "${definition.name}" must declare output`);
        }
        if (typeof definition.output.render !== 'function') {
          throw new TypeError(`tool "${definition.name}" output.render must be a function`);
        }
        if (!definition.output.schema || typeof definition.output.schema !== 'object') {
          throw new TypeError(`tool "${definition.name}" must declare output.schema`);
        }
        if (typeof definition.execute !== 'function') {
          throw new TypeError(`tool "${definition.name}" must declare execute`);
        }
        tools.push(definition);
        return () => {};
      },
    },
    commands: {
      register(command) {
        commands.push(command);
        return () => {};
      },
    },
    webServer: {
      port: 54125,
      getOrigin: () => 'http://127.0.0.1:54125',
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    get(name) {
      return services[name];
    },
  };

  // 严格 getter：与真实宿主一致，未声明的服务一读就抛。
  const services = { tools: ctx.tools, commands: ctx.commands, webServer: ctx.webServer };
  for (const [name, value] of Object.entries(services)) {
    Object.defineProperty(ctx, name, {
      enumerable: true,
      configurable: true,
      get() {
        if (!injected.includes(name)) {
          throw new Error(`service "${name}" 没写进 inject 就被读取了`);
        }
        return value;
      },
    });
  }

  return { ctx, tools, commands, routes, disposers, logs };
}

/** 等待 index.js 里的异步初始化（bridgeStatus）落定。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

async function main() {
  const mod = await import('../lib/index.js');
  const { apply } = mod;
  const injected = mod.inject ?? [];
  const harness = makeCtx({ injected });

  await check('导出 inject：tools / commands / webServer 都必须声明', () => {
    for (const name of ['tools', 'commands', 'webServer']) {
      ok(injected.includes(name), `inject 缺少 ${name}：严格 getter 下读取会抛异常`);
    }
  });

  await check('没声明 inject 时不会静默成功（回归：HUD 一直连接中）', () => {
    const bare = makeCtx({ injected: [] });
    apply(bare.ctx, { observe: { enabled: false } });
    eq(bare.tools.length, 0, '未声明 inject 时不该注册上工具');
    ok(
      bare.logs.error.length + bare.logs.warn.length > 0,
      '注册失败必须留下日志，否则真机上无从排查',
    );
  });

  await check('apply 不抛异常且允许被调用两次（重载幂等）', () => {
    apply(harness.ctx, { observe: { enabled: false } });
    apply(harness.ctx, { observe: { enabled: false } });
    eq(harness.logs.error.length, 0, '不应有 error 日志');
  });

  await settle();

  await check('注册了 6 个工具', () => {
    eq(harness.tools.length, 12, '调用两次应各注册 6 个（宿主侧靠 effect 回收）');
    const names = new Set(harness.tools.map((t) => t.name));
    for (const expected of [
      'companion_windows',
      'companion_read',
      'companion_capture',
      'companion_watch',
      'companion_say',
      'companion_last_capture',
    ]) {
      ok(names.has(expected), `缺少工具 ${expected}`);
    }
  });

  await check('注册了 companion 命令', () => {
    const command = harness.commands.find((c) => c.name === 'companion');
    ok(command, '缺少 companion 命令');
    eq(typeof command.handler, 'function');
  });

  await check('注册了 /dsh-companion-journal-8201 前缀路由', () => {
    const route = harness.routes.find((r) => r.path === '/dsh-companion-journal-8201');
    ok(route, '缺少状态路由');
    eq(route.kind, 'prefix');
  });

  // 菜单轮询是长驻循环：测试里不能让它一直缠着，注册完就把 effect 收掉。
  await check('菜单循环随 effect 回收（不会把进程钉住）', () => {
    for (const dispose of harness.disposers) {
      try {
        dispose?.();
      } catch {
        /* 回收失败不影响断言 */
      }
    }
  });

  // 同一次 apply 的工具（取最后一组，避免重复注册干扰）
  const tool = (name) => harness.tools.filter((t) => t.name === name).at(-1);

  await check('companion_windows 能跑通原生桥', async () => {
    const value = await tool('companion_windows').execute({ includeUntitled: true }, {});
    ok(typeof value.frontApp === 'string', 'frontApp 应为字符串');
    ok(Array.isArray(value.windows), 'windows 应为数组');
    ok(value.count === value.windows.length, 'count 应与数组长度一致');
    // 本机至少有 DSH 自己这个窗口；GitHub 的 headless runner 没有 WindowServer，
    // 枚举到 0 是环境事实，不是桥坏了。CI 上只要求给出可判定的结果结构。
    if (process.env.CI !== 'true') {
      ok(value.count > 0, '应至少枚举到一个窗口');
    }
  });

  await check('companion_read 在当前环境给出可判定的来源', async () => {
    const def = tool('companion_read');
    const value = await def.execute({}, {});
    ok(typeof value.source === 'string' && value.source.length > 0, 'source 不应为空');
    ok(typeof value.text === 'string', 'text 应为字符串');
    ok(typeof value.app === 'string', 'app 应为字符串');
    // 渲染器必须能把值渲染成内容块
    const rendered = def.output.render({}, value);
    ok(Array.isArray(rendered) && rendered[0].type === 'text', 'render 应返回 text 块');
  });

  await check('companion_capture 失败时给的是授权指引而非空图', async () => {
    const def = tool('companion_capture');
    try {
      const value = await def.execute({ target: 'screen' }, {});
      // 有权限的环境下应该真出图
      ok(value.width > 0 && value.height > 0, '有权限时应返回像素尺寸');
    } catch (error) {
      includes(error.message, '截图失败', '错误应说明是截图环节');
      includes(error.message, '屏幕录制', '错误应指引到屏幕录制授权');
    }
  });

  await check('companion_capture 在没有图片能力时不会假装附上了', async () => {
    const def = tool('companion_capture');
    // exec 不带 agent/attachments：attachImage 必然返回 null，此时应 attached:false
    try {
      const value = await def.execute({ target: 'screen' }, {});
      eq(value.attached, false, '无附件服务时不该声称已附图');
      includes(def.output.render({}, value)[0].text, '没能附成图片', '渲染应提示附图失败');
    } catch (error) {
      // 无权限环境直接失败也接受（上面那条已覆盖消息质量）
      includes(error.message, '截图失败');
    }
  });

  await check('companion_watch status 可用且默认关闭', async () => {
    const value = await tool('companion_watch').execute({ action: 'status' }, {});
    eq(value.enabled, false, '默认应为关闭');
    eq(value.intervalMs, 5000);
    ok(typeof value.ticks === 'number');
  });

  await check('companion_say 在没有桌宠时优雅降级', async () => {
    const value = await tool('companion_say').execute({ text: '测试一句' }, {});
    // 桌宠装了且端口对：ok=true；否则应给出 reason，而不是抛异常
    ok(typeof value.ok === 'boolean', 'ok 应为布尔');
    if (!value.ok) ok(value.reason.length > 0, '失败必须带 reason');
  });

  await check('状态路由能返回 JSON', async () => {
    const route = harness.routes.find((r) => r.path === '/dsh-companion-journal-8201');
    const req = { url: '/dsh-companion-journal-8201/state', method: 'GET' };
    let status = 0;
    let body = '';
    const res = {
      destroyed: false,
      writableEnded: false,
      writeHead(code) {
        status = code;
      },
      end(chunk) {
        body += chunk;
        res.writableEnded = true;
      },
    };
    await route.handler(req, res);
    eq(status, 200);
    const parsed = JSON.parse(body);
    eq(parsed.ok, true);
    ok(parsed.observer, 'state 应带 observer');
    ok(parsed.bridge, 'state 应带 bridge 状态');
  });

  // ── 汇总 ──────────────────────────────────────────────────────────────────
  if (failures.length > 0) {
    console.error(`✗ ${failures.length} 项失败（通过 ${passed} 项）`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`✓ plugin 契约 ${passed} 项全过`);
}

main().catch((error) => {
  console.error(`✗ 测试崩了：${String(error?.stack ?? error)}`);
  process.exit(1);
});
