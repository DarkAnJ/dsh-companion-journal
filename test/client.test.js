/**
 * 客户端半侧契约测试：在没有浏览器的情况下验证浏览器模块的形状。
 *
 * 为什么值得单独测：客户端插件坏了在宿主日志里只有一行
 * "slot entry crashed"，其余什么都不说；而它又无法用 `node --check` 校验
 * （模块体在 `window.__ModuleLoader__` 里，顶层就引用 window）。
 * 这里用一个假的模块装载器把它跑起来，钉住三件事：
 *   1. 模块 id 与包名一致（loader 用它做去重与 HMR 定位）；
 *   2. factory 只依赖 require('react')，不偷偷 require 别的包；
 *   3. apply 注册的插槽名与 id 是我们要的那一个。
 *
 *   node test/client.test.js
 *
 * @module dsh-companion-journal/test/client
 */

import { readFileSync } from 'node:fs';

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

// ── 假的浏览器环境 ──────────────────────────────────────────────────────────

const captured = { module: null };
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured.module = definition;
    },
  },
  // apply 里会挂 focus 兜底监听（陪伴记录跳转的第二条通道），这里只需接住即可。
  addEventListener() {},
  removeEventListener() {},
};

// apply 时会 POST 一次客户端版本（宿主据此提醒「重启客户端」），这里给个空实现。
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

// apply 里会给 document 挂 visibilitychange（补查 pending），这里给个最小实现。
globalThis.document = {
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
};

const requiredPackages = [];
const reactStub = {
  createElement: (...args) => ({ type: 'element', args }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
};

await import('../lib/client.js');

check('CLIENT_VERSION 等于 package.json 的 dsh.clientVersion', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const found = /const CLIENT_VERSION = '([^']+)'/.exec(source)?.[1];
  ok(found, '缺少 CLIENT_VERSION 常量（宿主靠它判断客户端是否过期）');
  eq(found, String(pkg?.dsh?.clientVersion ?? ''), '改了 lib/client.js 就要同步改 package.json 的 dsh.clientVersion');
});

check('模块被 __ModuleLoader__ 装载', () => {
  ok(captured.module, '没有调用 window.__ModuleLoader__.load');
});

check('模块 id 与包名一致', () => {
  eq(captured.module.id, 'dsh-companion-journal');
});

const moduleDefinition = captured.module.factory((specifier) => {
  requiredPackages.push(specifier);
  if (specifier === 'react') return reactStub;
  throw new Error(`客户端插件不该 require('${specifier}')：宿主 Client 包不在插件可用范围内`);
});

check('factory 只 require react', () => {
  eq(requiredPackages.join(','), 'react');
});

check('声明 inject slots', () => {
  ok(Array.isArray(moduleDefinition.inject), 'inject 应为数组');
  ok(moduleDefinition.inject.includes('slots'), 'inject 应包含 slots');
});

check('apply 注册面板与设置页', () => {
  const registrations = [];
  const injected = [];
  const ctx = {
    // apply 里用 ctx.effect 挂/摘生命周期资源（SSE、focus 监听）。
    effect: (callback) => {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    slots: {
      inject(key, callback) {
        injected.push(key);
        callback();
        return () => {};
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  moduleDefinition.apply(ctx);
  ok(injected.includes('sidebar.panellist'), '要有侧边栏入口');
  ok(injected.includes('main'), '要有主区面板');
  // 页内 HUD 已删除（v0.37.0）；任何人再加回来都要先过「不许常驻轮询」这道关。
  ok(!registrations.some((r) => r.options.name === 'shell.overlay' || r.options.id === 'dsh-companion-journal-hud'), '不该再注册 shell.overlay');
  const panel = registrations.find((r) => r.options.key === 'dsh-companion-journal-history');
  ok(panel, '缺少陪伴记录面板注册');
  ok(typeof panel.component === 'function', '面板应是 React 组件');
});

check('陪伴记录面板：能渲染出搜索框、列表面与两个清理入口', () => {
  const registrations = [];
  const ctx = {
    // apply 里用 ctx.effect 挂/摘生命周期资源（SSE、focus 监听）。
    effect: (callback) => {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    slots: {
      inject: (_key, callback) => {
        callback();
        return () => {};
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  moduleDefinition.apply(ctx);
  const panel = registrations.find((r) => r.options.key === 'dsh-companion-journal-history');
  ok(panel, '缺少面板注册');

  const tree = panel.component({});
  ok(tree && tree.type === 'element', '面板应返回元素');

  // 递归收集树上所有字符串，断言关键交互都在
  const texts = [];
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      texts.push(node);
      return;
    }
    if (typeof node === 'number') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node.type === 'element') {
      const args = node.args ?? [];
      for (const child of args.slice(2)) walk(child);
    }
  };
  walk(tree);
  const joined = texts.join(' | ');
  ok(joined.includes('共 0 条'), `应显示统计行：${joined}`);
  ok(joined.includes('只清理截图'), '缺少「只清理截图」按钮');
  ok(joined.includes('删除全部记录'), '缺少「删除全部记录」按钮');
  ok(joined.includes('今天') && joined.includes('7 天') && joined.includes('30 天'), '缺少时间范围切换');
});

check('侧边栏图标：能渲染且带标题', () => {
  const registrations = [];
  const ctx = {
    // apply 里用 ctx.effect 挂/摘生命周期资源（SSE、focus 监听）。
    effect: (callback) => {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    slots: {
      inject: (_key, callback) => {
        callback();
        return () => {};
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  moduleDefinition.apply(ctx);
  const icon = registrations.find((r) => r.options.id === 'dsh-companion-journal-history');
  ok(icon, '缺少侧边栏图标注册');
  eq(icon.options.name, 'sidebar.panellist');
  const tree = icon.component({});
  ok(tree && tree.type === 'element', '图标应返回元素');
  eq(tree.args[0], 'svg', '图标必须是内联 SVG（字形会与官方图标对不齐）');
  eq(tree.args[1].width, 16, '默认尺寸应与侧边栏其它图标一致');
  ok(tree.args[1].stroke === 'currentColor', '颜色要跟随主题');
});

// 源码级守卫：大图层这两处很容易被“顺手简化”掉，而浏览器里坏了没有任何日志。
check('大图层：原图地址带 index，且有左右切换按钮', () => {
  // 同步读：check() 不 await，异步失败会变成 unhandled rejection 而不是「失败一项」。
  const text = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  ok(text.includes('history/image/${encodeURIComponent(zoom.id)}?index=${index}'), '原图地址必须带 index（否则永远显示第一张）');
  ok(text.includes('panelStyles.zoomArrow('), '缺少左右切换按钮');
  ok(text.includes("'ArrowLeft'"), '缺少键盘左右切换');
  // 回归：多画面记录只截到一张时，total === 1 曾让点击直接落空。
  ok(text.includes("item.kind === 'multi'"), '多画面记录不能只靠图片张数判断');
  // 「陪伴记录」跳转必须有两通道：SSE 主通道 + 窗口聚焦时的 pending 兜底。
  ok(text.includes("new EventSource('/dsh-companion-journal-8201/buddy/events')"), '缺少 SSE 主通道');
  ok(text.includes("'/dsh-companion-journal-8201/buddy/pending'"), '缺少窗口聚焦时的兜底通道');
  ok(text.includes("addEventListener('focus'"), '兜底必须挂在 focus 事件上（不许定时轮询）');
  // 回归：插件重挂会把 SSE 关掉，页面不重跑 apply → 菜单点了没反应。
  ok(text.includes('window.__dshCompanionSSE'), '连接必须做成页面级单例（活过插件重挂）');
  ok(!text.includes('source.close()'), '不该在 apply 卸载时关闭这条共享连接');
  ok(text.includes("addEventListener('pointerdown'"), 'DSH 已在前台时要有第二个触发点');
  // 宫格必须放在卡片级（横排下面），塞进缩略图列会把右侧文字挤走。
  ok(text.includes('cardImages.map('), '展开的宫格应渲染在卡片级');
  ok(text.includes("flexDirection: 'column'"), '卡片应改为纵向布局');
  // 面板：头部（搜索 + 统计 + 多选操作）固定，列表自己滚。
  ok(text.includes('panelStyles.header'), '缺少固定头部容器');
  ok(text.includes('panelStyles.scroll'), '缺少独立滚动区');
  ok(!text.includes("wrap: { padding: '16px 20px', overflowY: 'auto'"), '外层不该再是滚动容器');
});

// ── 汇总 ────────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`✗ ${failures.length} 项失败（通过 ${passed} 项）`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`✓ client 契约 ${passed} 项全过`);
