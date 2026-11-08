# 开发日志 · dsh-companion

> 说明：本文件记录的是改名前的历史，文中的 `dsh-companion` 即今天的 `dsh-companion-journal`。


> **维护约定**
> 1. 每次有实质改动，在文末「变更记录」追加一条（版本 / 日期 / 改了什么 / 为什么）。
> 2. 新实测出来的事实补进「已确认事实」；推断与假设补进「未验证假设」，验证后就移过去。
> 3. 「未定事项」里的条目一旦定了实现方案，从上面删掉、在变更记录里写明结论 —— 不要让同一个决策在两处各说一遍。
> 4. 写事实要带**证据**（哪条命令、哪个文件、哪个报错），不写「应该可以」。

---

## 0. 这个项目是什么

一个**自带桌宠的感知与协同插件**：一张可选的自绘立绘浮窗，加上「看一眼」的抓取、模型调用、陪伴记录与「据此开会话」。

一句话架构（2026-11-07 现状）：

```
                     ┌─ 全局热键（F8 / F7，Carbon，由浮窗进程注册）
用户 ────────────────┤
                     └─ 点/双击桌宠
                              │
                              ▼
        dsh-companion（宿主 Node 半侧）
          ├─ 抓取：原生桥 dsh-bridge（窗口 / 截图 / 选中文字 / 文件选择）
          ├─ 理解：ctx.llm（文本优先，图片按需）
          ├─ 留痕：history.jsonl（图 + 文 + 问答线程）
          └─ 表达：气泡 / 输入面板 —— 都由 dsh-buddy（自绘 AppKit 进程）画
```

历史包袱说明：v0.1 ~ v0.13 期间，桌宠本体用的是第三方 `dsh-pet` 插件；v0.14 起改成**自绘浮窗**（`buddy/`），v0.14.0 已把 `lib/pet.js` 删除，`test/decoupling.js` 守着「不再出现 dsh-pet 调用」。本文档里 D1 / D10 / D12 / D13 已标注为废弃，保留是为了记录当时的推理与踩坑。

它不碰 DSH 内核；所有原生能力走自带的两个 Swift 二进制（桥 + 浮窗）。

---

## 1. 环境基线（2026-11-04 实测）

| 项 | 值 | 备注 |
|---|---|---|
| 操作系统 | macOS 26.6.2 (25G83) | Apple Silicon |
| DSH | `0.2.1-rc.5` | 从 `app.asar/dsh/package.json` 读出 |
| profile | `desktop` | `DSH_PROFILE=desktop`，`DSH_HOME=~/.dsh` |
| 模型 | `deepseek-account / deepseek-flash`，reasoning `high` | `~/.dsh/profiles/desktop/cordis.patch.yml` |
| dsh-pet | `0.4.1` | **已停用**（v0.14 起与本插件解耦，卸载不影响功能） |
| 同 profile 其它 bundle | `dshmarket` / `dsh-better-sidebar` / `dsh-whale-widget` / `dsh-context` | |
| Swift 工具链 | `/usr/bin/swiftc`（Xcode CLT） | 编译原生桥用 |
| DSH GUI 端口 | **每次启动都变** | 本次会话内从 `54125` 变成 `61799` |

> 端口那条很关键：任何脚本都不能硬编码端口。插件内一律读 `ctx.webServer.port` / `getOrigin()`。

### 当前授权状态

| 权限 | 状态 | 影响 |
|---|---|---|
| 屏幕录制 | ✅ 已授予（2026-11-04 16:44 前后生效） | 截图、窗口标题可用 |
| 辅助功能 | ✅ 已授予（2026-11-07 实测 `bridge trust` 返回 true） | 选中文字 / 窗口标题 / 桌面判定都依赖它 |
| 输入监控 | ❌ 未授予 | 不影响：热键走 Carbon `RegisterEventHotKey`，不需要输入监控 |
| 自动化（Word） | ❌ 未授予 | Word 正文读取返回 `-10004` |

---

## 2. 已确认事实

### 2.1 DSH 插件机制

- 插件 = 包 + `package.json` 里的 `dsh.bundle.patch`；patch YAML 里 `insert` 一行，`id` 必须与包名一致。
- **`ctx` 是严格 getter：读一个没写进 `inject` 的服务会抛异常，不是返回 undefined。** 插件必须自己导出 `inject = [...]`；否则 `ctx.tools` / `ctx.commands` / `ctx.webServer` 一读就抛，而 apply 里的 try/catch 会把它们逐个吞掉 → 「apply 成功、零注册」。v0.1.0 装机后 HUD 一直「连接中」、五个工具和 `/companion` 全消失，就是这个（见 K11）。
- 服务名就是 `tools` / `commands` / `webServer`（对照 dsh-pet、dsh-better-sidebar 的 inject 确认）。可选服务（attachments / llm / subprocess）不要写进 inject：对象级 inject 会把整个 apply 推迟到服务齐备，缺一个就永远不加载；用 `ctx.get(name, false)` 软取。
- bundle patch 与手写 `cordis.patch.yml` 行**只能二选一**，两边都写会双重挂载 → `already registered`，严重时 DSH 起不来。
- 宿主半侧 `apply(ctx, config)` 抛异常 = DSH 起不来 + 进安全模式 + **重写 profile 把插件删掉**。所以 `apply()` 全程 try/catch。
- `ctx.tools.register(definition)` 的实际硬校验只有三条：`name`、`output.schema`、`output.render` 是函数。缺 `render` 才 TypeError —— 这就是不需要 `defineTool` 的原因。
- 工具返回值会被 `output.schema` 校验（严格），所以**返回值必须是纯 JSON**，图片塞不进返回值。
- 图片只能走 `finalizeContent(exec, result)`；`applyFinalContent` **不 await**，所以附件必须在 `execute` 里先存好，`finalizeContent` 只做同步挂载。
- 附件链路：`ctx.get('attachments').saveImages([{data: Uint8Array, mediaType, name}])` → `{type:'image', attachment: ref}`；前置要求模型 `inputModalities` 含 `image`。
- 起子进程必须用 `ctx.subprocess`；裸 `node:child_process` 在宿主沙箱下管道 stdio 会 `EPERM`。
- 宿主端口：`ctx.webServer.port`、`ctx.webServer.getOrigin()`、`ctx.webServer.register({kind:'prefix', path, handler})`。
- 命令：`ctx.commands.register({name, description, input:{hint}, handler})`，handler 返回 `{kind:'success'|'error', text}`。
- 客户端插件：`window.__ModuleLoader__.load({id, factory(require){...}})`，`id` 等于包名，`factory` 里只能 `require('react')`；插槽注册用 `ctx.slots.inject(key, () => ctx.slots.register({name, id, order}, Component))`。
- 客户端崩溃只会在控制台留一行 `slot entry crashed in '<slot>'`，宿主日志里什么都没有。

### 2.2 dsh-pet 对外接口（历史资料 · v0.14 起已不再依赖）

> 下面仅供参考：我们已自绘桌宠，代码里不再调用这些接口。留着是因为它记录了「第三方插件能做什么」的边界。

- 路由前缀常量：`src/shared/constants.ts` → `ROUTE_SEGMENT = '/dsh-pet-7340'`。
- 可用端点：`POST /broadcast?pet=`（第三方给定文本，不生成）、`POST /anim?pet=`（播素材动画）、`GET /state`、`GET /config`、`POST /whisper`（会调模型生成）、`POST /lock`、`POST /position`。
- `broadcast` 的 body：`{text, image?|url?, duration?, anim?}`，`duration` 默认 10s，`anim` 只有严格 `false` 才关闭。
- **`/broadcast` 与 `/anim` 的 query 必填 `surface`**（`web` / `desktop` / `both` / `any`）。缺了不会 4xx，而是 **HTTP 200 + `{ok:false, reason:'bad-request'}`** —— 调用方只看状态码就会把「被拒绝」当成「已经开口了」（见 K12）。`any` 是唯一在 web / desktop / both / none 四种 display 下都不被拒的取值。
- **dsh-pet 必须出现在 profile 的 `dsh.profile.bundles` 里**，DSH 才会注册 `/dsh-pet-7340`。只在 `dependencies` 里是不够的：桌宠窗口可能来自上一个 DSH 进程遗留的孤儿 helper（它的日志里 `config:` 指向旧端口），看起来「在跑」，其实耳朵是断的（见 K13）。
- 宿主半侧还 `ctx.provide('petApi7340', ...)`，同页客户端插件可用 `ctx.get('petApi7340')` 零网络调用。
- **只用 `/broadcast` 与 `/anim`，不用 `/chat` / `/whisper`**：后两者会调模型生成台词，旁观场景下贵且不可控。

### 2.3 macOS 侧

- 窗口枚举与窗口 id **不需要任何授权**：`CGWindowListCopyWindowInfo` 给 `kCGWindowNumber` / `kCGWindowOwnerName` / bounds。
- **窗口标题需要屏幕录制授权**：未授权时 `kCGWindowName` 整个键都不存在（不是空字符串）。
- `screencapture -l <windowId>` 未授权时的失败信息是 `could not create image from window`，退出码 1 —— 可据此精确判定 `no-permission`。
- 退到前台应用不需要辅助功能：`NSWorkspace.frontmostApplication`（`lsappinfo front` 也行）。
- 空闲时长零授权：`CGEventSource.secondsSinceLastEventType(.combinedSessionState, ~0)`。
- Word 16.113.4：`tell application "Microsoft Word" to get version` 成功；读 `active document` 报 `A privilege violation occurred. (-10004)`，即自动化授权未给。
- TCC 授权之后**必须重启应用**才生效。
- `swiftc` 可交叉编译：`-target x86_64-apple-macos11` 在 Apple Silicon 上成功，`lipo -create` 出通用二进制。

### 2.4 分发侧

- 包可以零运行时依赖：本项目运行时不 import 任何 `@deepseek-ai/*`，避免 link 安装时 peer 解析失败。
- `files` 决定 git/npm 装到别人机器上有什么；漏一条就是「别人装了但某功能一直失败」。有 `test/pack.test.js` 兜底。
- `private: true` 只挡 npm publish，不挡 git 安装。

---

## 3. 未验证假设

> 这些是**按源码/文档推断**的，尚未在本机跑通。谁先验到就把它挪进第 2 节。

2026-11-04 装机后已验（从本表移出，结论见第 2 节）：A1 `shell.overlay` 插槽、A2 `/plugins/<pkg>/client.js`、A3 本地目录安装、A4 斜杠命令、A5 截图附件、A7 桌宠开口。
其中 A5 与 A7 都不是「一装就好」：A7 被 K12（200+ok:false）与 K13（桌宠插件未挂载）连坑两次。

| # | 假设 | 怎么验 | 风险 |
|---|---|---|---|
| A6 | Zotero 本地 API（`127.0.0.1:23119/api/users/0/items`）可用 | 在 Zotero 开开关后读一次 | 中：需手动开 |
| A8 | 观察器定时器与 `ctx.effect` 的回收在真实宿主里行为一致 | 卸载/重载插件观察 | 低 |

## 4. 架构决策记录

> 状态标记：✅ 有效 ／ ⛔ 已废弃（保留推理过程与踩坑记录）

### D14 · ✅ 自绘桌宠，替换 dsh-pet（v0.14 ~ v0.27）

- 背景：D1 把「身体」交给 dsh-pet，但它的快捷键只是**窗口内按键**（`isBareKey` 判断事件目标，没有 `globalShortcut`），拿不到全局热键；菜单项被塞进「更多」；HTTP 契约无文档、升级即风险。
- 决定：自绘一个 AppKit 浮窗进程 `buddy/dsh-buddy`（无 Electron），职责是「画立绘 + 画气泡 + 弹输入面板 + 注册全局热键」。
- 通信：全部走文件（`buddy.say.json` / `buddy.press.jsonl` / `buddy.ask.*` / `buddy.state.json` / `buddy.recenter.json`），插件与浮窗互不拖累。
- 派生决定：
  - **热键注册在浮窗进程**（Carbon `RegisterEventHotKey`）。从 Node 宿主注册会「成功但收不到事件」，因为它没有 AppKit 事件循环。
  - **气泡与输入面板由浮窗绘制**，位置贴着人物；输入框是多行 `NSTextView`，不是 osascript 的 `display dialog`（后者单行、居中、Esc 失效）。
  - 选中文字读取分三层：`AXSelectedText` → `AXSelectedTextRange`+参数化取串 → ⌘C + 剪贴板兜底（微信这类自绘界面只有最后一条路）。
- 后果：`lib/pet.js` 删除；`test/decoupling.js` 断言源码里不再出现 `dsh-pet` / `petId`。
- 代价：浮窗崩了是我们的 bug（有退避重启 + 状态自检）；多一个二进制要随包分发（universal，`buddy/build.sh`）。

### D1 · ⛔ 复用 dsh-pet 当「身体」，不重做宠物（已被 D14 取代）
- 背景：自研透明置顶窗 + 多屏 + 物理手感 + 100+ 动画，工作量与 dsh-pet 同级。
- 决定：本体交给 dsh-pet，本项目只做感知与协同；两边通过它已公开的 HTTP 契约解耦。
- 后果：dsh-pet 升级可能改契约 → 所有调用都包 `{ok:false, reason}` 降级，不抛错。

### D2 · 文本优先，截图兜底
- 决定：能拿文本就不截图（Word AppleScript / PDFKit / 适配器）。
- 理由：文本准、快、便宜，且不消耗图片预算；截图再 OCR 会在公式、脚注、双栏上出错。
- 后果：只有「拿不到文本」或「用户明确要看图」才走 `companion_capture`。

### D3 · 原生桥用 Swift 编译，不用 JXA / 原生模块
- 理由见 K1、K2。
- 后果：多一个编译步骤；用 universal 二进制抵消架构问题；首次运行不依赖 Xcode。

### D4 · 零 `@deepseek-ai/*` 运行时依赖
- 决定：手写工具定义（已确认 `register()` 只校验三样），配置用「默认值 + 纠错告警」而不是 schemastery。
- 代价：配置写错不会被 schema 拦住，只能告警。
- 收益：`link:` 安装、任意 profile、任意 DSH 小版本都不容易因 peer 崩。

### D5 · HTTP 客户端用 `node:http`，不用全局 `fetch`
- 起因：真踩到 `fetch is not defined`（K2）。
- 后果：多 60 行，但行为跨 Node 版本一致。

### D6 · 旁白不调模型（✅ 原则不变；投递通道已改为浮窗气泡）
- 决定：旁观旁白由模板生成，只做「投递一句话」——当时走 dsh-pet `/broadcast`，v0.14 起改为写 `buddy.say.json`（`lib/surface.js`）。
- 理由：成本 0、节奏可控；需要「判断」的场合由用户主动发问。

### D7 · 采样而非录屏
- 决定：默认 20s 一次取前台 app + 标题 + 空闲秒数，签名不变直接返回。
- 理由：录屏既贵又侵犯隐私，且绝大多数时刻画面没有信息增量。

### D13 · ⛔ 热键注册在宿主进程；选中优先；抓取留痕（热键部分已被 D14 取代）
- 背景：点桌宠会**抢焦点**（实测 `lastFront: "Electron"`），导致「你刚才在看什么」在点击瞬间就丢了；多屏下 z-order 也不可靠。
- 决定：用 Electron `globalShortcut` 在 DSH 主进程注册全局热键——零新进程、空闲不醒、按下不抢焦点。按下时先读 `AXSelectedText`：有选中走文本路径，没有才截图。
- 决定：每次抓取在进程内存记一份「最近一次抓取」，用 `companion_last_capture` 供后续对话取用，替代「猜窗口标题」。
- 实现修正：桌面端宿主是**普通 Node 进程**，拿不到 `globalShortcut`（实测 `error: 宿主没有暴露 Electron globalShortcut`）。于是补了桥的常驻监听 `dsh-bridge hotkeys --spec --events <file>`：Carbon `RegisterEventHotKey` + 文件追加 + 插件侧 `fs.watch`（事件驱动，不轮询）。`/state` 的 `hotkey.backend` 标明用的是哪条。
- 未做（明确范围外）：菜单平铺 patch、待处理槽 UI。
- 代价：辅助功能未授权时选中路径不可用，只能看窗口（平台限制，会明说）。

### D12 · ⛔ 控制入口搬到桌宠右键菜单（已被 D14 取代：现在用浮窗自己的右键菜单）
- 背景：HUD 只在 DSH 窗口里可见；用户在写 Word 时想让它看一眼，却必须切回 DSH —— 而那一刻「前台窗口」已经变成 DSH 自己。
- 决定：用 dsh-pet 的第三方右键菜单注册表（`POST /menu/item` + 长轮询 `/menu/events`）把「看一眼」挂到宠物身上。点它时找 **CGWindowList 里 DSH 下面的第一个正常窗口**，按 windowId 后台截图（不激活、不抢焦点），再让当前模型看图说一句。
- 后果：入口的问题解决了；反馈从「模板旁白」升级成「模型看图」，每次点击一次视觉调用（用户主动触发，成本可接受）。
- 约束：不改「前台窗口」的定义——旁观器与其它工具仍然只认真前台，这是独立的一条路。

### D11 · 只要窗口切换就说话，台词不描述窗口
- 背景：D9 的「按活动类别说」实测两次都没被听见——分类再准，用户要的是「换个窗口它有点反应」，而不是一份活动报告。
- 决定：任何场景签名变化都开口（DSH 自己的窗口除外），台词从固定短句池随机取、相邻不重复、**不含应用名/文档名**。
- 后果：分类逻辑（`sceneCategory` / `narrateTransition`）暂时退出主链路，函数与测试保留，等要做「有判断的旁白」时再启用。
- 节奏：采样 5s、最小间隔 20s、每小时 60 句 —— 先让「换窗口有反应」这件事成立，嫌吵再调。

### D10 · ⛔ DSH 自己的窗口是透明的；「看一眼」回看最近一次别处采样（已被 v0.20 取代：现在前台是谁就看谁，桌面/浮层走整屏）
- 背景：HUD 只能在前端点，点的时候前台必然是 DSH —— 重新采样只会得到「你在看 DeepSeek Harness」，这个按钮等于没用（用户实测提出的问题，成立）。
- 决定：`isHostApp` 判定 `com.deepseek.dsh` / `DeepSeek Harness`，它既不更新活动类别也不更新 `lastActivity`；`force`（看一眼 / once）改为报 `narrateLastSeen(lastActivity)`。
- 后果：胶囊文案、`/state`、`/companion status` 都改报「最近一次别处」；顺带修掉「切到 DSH 再切回来，类别被冲成 other 导致再也不说话」的连锁问题。

### D9 · 按「活动类别」切换触发旁白，不按窗口变化
- 背景：最初是「窗口签名一变就说一句」，实测窗口标题每换一个标签页就变 → 要么被限频吞光，要么变成骚扰。
- 决定：先判类别（work / fun / social / other），只在**已知类别之间**变化时开口；同一类里换文件、换标签页不出声；从 other（DSH 窗口、Finder）切过去也不出声——你本来就没离开工作。
- 后果：真正的「办公↔娱乐」切换一定会被说出来；代价是办公室内换文档时它不说话（可以靠 `companion_watch once` 主动要一句）。
- 默认节奏同步调紧：采样 10s、最小间隔 3 分钟（20s + 5 分钟时，切换后要等很久才被注意到）。

### D8 · 截图走 `finalizeContent`
- 起因：`output.schema` 是严格 JSON，图片塞不进返回值（K4）。

---

## 5. 已知限制（v0.27.3）

- **只读，不代点**：不模拟鼠标键盘（热键除外）。
- **人物贴边时出气泡会被轻推**：气泡与人物同窗口，窗口变宽时只能往右长。方案见 ROADMAP「已知问题 1」。
- **气泡里不渲染 Markdown**：模型若输出 `**粗体**` 会原样显示。
- **输入框只支持单段文本**：不支持粘贴富文本/图片，也没有历史记录。
- **快捷键录制**：v0.27.3 改成原生输入框 + 诊断显示，仍待实机确认；备选方案是「让浮窗自己录键」。
- **热键写法受限**：只支持 F1–F12、字母、数字、空格/回车/Tab + 四种修饰键。
- **记录与会话没有关联**：已用某条记录开过会话，面板上看不出来。
- **非 macOS 只注册 `companion_say`**（其余能力依赖 Swift 桥）。
- **桌面/系统浮层只能整屏截图**：macOS 不把桌面当窗口，AX 也拿不到「桌面」这个对象。

---

## 6. 未定事项

> 按建议优先级排序。「阻塞」列写明卡在哪。

### U1 · Chrome 扩展桥 + 文献检索（原计划 P4）
- 现状：`companion_read` 对 Chrome/Safari 只返回标题 + 一句「正文需要扩展桥」。
- 方案 A：直接评估并依赖现成的 [`@yuxianglin/dsh-bridge-browser`](https://github.com/omdsh-dev/dsh-browser)（扩展 ↔ `/ext/bridge` WebSocket ↔ `browser_*` 工具，保留真实登录态）。
- 方案 B：自研扩展 + 本机 WS 桥。
- 决定点：A 的许可/维护度是否可接受；与我们的 `companion_read` 如何分工（避免两套浏览器工具并存）。
- 阻塞：无。建议先评估 A。

### U2 · 「陪伴记录」面板 —— ✅ 已完成（v0.6 ~ v0.25）

> 已实现：`sidebar.panellist` 入口 + `main` keyed 面板，含搜索、时间范围、逐条追问、开会话、右键多选、批量删除。
> 仅剩「Markdown 渲染」未做。

- 原计划：只有 `shell.overlay` 胶囊。
- 需要：右侧面板列出观察卡片 / 建议卡片，点卡片能「让桌宠读这个」。
- 决定点：放 `rightbar` 还是 `main` keyed slot；卡片数据存哪（session event vs 插件自有存储）。
- 阻塞：A1（插槽名要先在真实页面确认）。

### U3 · 跨平台
- 现状：Windows/Linux 只保留 `companion_say`。
- 参考：社区 `dsh-desktop-hand` / `@azhe0306/dsh-connectors` 的 `desktop-connector` 是 Windows 实现（`PrintWindow` + `SendInput`），可借鉴。
- 决定点：值不值得做；做的话是「一套接口两套实现」还是「各平台独立插件」。
- 阻塞：无。纯优先级问题。

### U4 · Zotero 当前选中条目的精确定位
- 现状：用窗口标题去本地 API 搜，可能搜不到或搜错。
- 可选：Zotero 的 `zotero://` URI、读 Zotero 数据库、让用户在对话里点名。
- 阻塞：需要 Zotero 实测（A6 未验）。

### U5 · 观察器与 agent 的联动
- 现状：旁白只走 `/broadcast`，不唤醒 agent。
- 想要：HUD「看一眼」能让 agent 主动说一段（需要 `agent/followup` 或会话注入，路径未确认）。
- 决定点：用 `agent.inject()`（不唤醒）还是 `agent.followup()`（唤醒）；对应的事件/handler 签名要先用 `cordis_inspect_query` 查。
- 阻塞：需要 Creator 模式或宿主检查器。

### U6 · 上架 dshmarket
- 现状：只保证「能装」，没提交市场。
- 已知门槛：entry id 必须与包名一致（已满足）；仓库需附 `LICENSE`（已有）。
- 阻塞：需要市场仓库的提交规范原文。

### U7 · 图片能力探测结果缓存
- 现状：每次截图都 `llm.resolveModelInfo()` 查一次。
- 影响：多一次服务调用（本地，开销小），暂不优化。
- 决定点：按 `provider:model` 缓存，模型切换时失效。

### U8 · 是否引入 schemastery 配置校验
- 现状：手写归一化 + 告警。
- 决定点：只有当「配置写错导致难排查」真的变成主要问题再引入。

### U9 · 权限引导 UI
- 现状：只给文字指引（系统设置路径）。
- 想要：HUD 上点一下直接跳 `x-apple.systempreferences:` 对应面板。
- 阻塞：无。

### U10 · 仓库初始化与发布
- 现状：目录里没有 `.git`；`package.json` 的 `repository.url` 还是占位 `USER`。
- 待办：`git init` → 改 `USER` → 推到 GitHub →（可选）`npm publish`。

### U11 · 桥的性能
- 现状：每次工具调用起一个进程（约 10–20ms）。
- 观察器 20s 一次，可接受；如果要做到 1s 级采样，需要常驻桥 + stdin/stdout 协议。

---

## 7. 踩过的坑

### K1 · JXA 的 ObjC 桥不可用（macOS 26）
- 症状：`$.CGWindowListCopyWindowInfo(...)` 返回值 `typeof === 'function'`；`ObjC.unwrap` 拿不到数组；`raw.count` 是 `NaN`；`castRefToObject` 后 `objectForKey` 报 `Ref has no type (-2700)`。
- 结论：放弃 JXA，改编译 Swift 助手。**不要**再尝试用 JXA 调 CoreGraphics。

### K2 · `fetch is not defined`
- 场景：Node 16 下跑测试，`pet.say` 直接返回 `{ok:false, reason:'fetch is not defined'}`，看起来像「桌宠没装」。
- 结论：全改 `node:http`（`lib/http.js`）。这类「环境缺失伪装成业务失败」最容易误导排障。

### K3 · 裸 `child_process` 在宿主沙箱里 EPERM
- 来源：`dsh-desktop-hand` 的工程笔记，与本项目一致（本项目一切走 `ctx.subprocess`，裸 spawn 只作脱离 DSH 的退路）。

### K4 · 图片塞不进工具返回值
- 症状：往返回值加图片字段会被 `output.schema` 校验拒绝。
- 结论：`execute` 里存附件，`finalizeContent` 里同步返回内容块。

### K5 · 客户端插件崩溃没有日志
- 症状：只有控制台 `slot entry crashed in '<slot>'`。
- 对策：`test/client.test.js` 用假 `__ModuleLoader__` 把客户端模块跑起来。

### K6 · swiftc 模块缓存吃掉 460MB
- 症状：`du -sh .` 从 264K 变 461M。
- 原因：`-module-cache-path ./.build/cache` 生成的 `.pcm` 文件很大，且 `.build` 是隐藏目录，`du -sh *` 看不见。
- 对策：`build.sh` 成功出包后 `rm -rf .build`；`.gitignore` 里已忽略。

### K7 · 沙箱里 curl DSH 端口会返回假响应
- 症状：`curl http://127.0.0.1:54125/dsh-pet-7340/config` 返回 `404`（GET）/ `405`（POST），而 dsh-pet 自己的日志显示它在用同一个 URL 正常取配置。
- 结论：**bash 沙箱下的 HTTP 探测不可信**，不能据此判断路由是否存在。验路由要看对端日志，或者在宿主进程内测。

### K8 · 端口每次启动都变
- 症状：上一轮 `54125`，这一轮 `61799`。
- 结论：一律读 `ctx.webServer`，不写死。

### K9 · `apply()` 抛错 = 插件被删
- 症状（理论后果，未亲历）：DSH 起不来 → 安全模式 → 重写 profile 去掉插件。
- 对策：`apply()` 每一段独立 try/catch，失败只降级 + 告警。

### K10 · TCC 授权后必须重启
- 屏幕录制授权生效前后，同一个二进制从「could not create image」变成能正常截图，中间只需要**重启应用**。

---

### K11 · 没导出 `inject` = apply「成功」但零注册
- 症状：装好后 HUD 永远「连接中」，五个工具不出现，`/companion` 不补全；宿主插件列表里该条目却是 `fiberPhase: active`。
- 原因：DSH 的 ctx 是严格 getter，`ctx.tools` / `ctx.commands` / `ctx.webServer` 在没写进 inject 时**抛异常**；apply 里三段独立 try/catch 各吞一个，最后照常打印「已加载」。
- 对策：导出 `inject = ['tools','commands','webServer']`；测试的假 ctx 改成严格 getter，并加「没声明 inject 时必须留下日志」的回归断言。

### K12 · 桌宠拒绝时回 HTTP 200
- 症状：`companion_say` 报成功、桌宠一句话没说；`/state` 里 `pets.<id>.say` 也没变。
- 原因：dsh-pet 0.4.x 的 `/broadcast` 缺 `?surface=` 时回的是 `200 + {ok:false, reason:'bad-request'}`，我们的 `call()` 只看状态码。
- 对策：`call()` 解析后检查 `value.ok === false`；两个动作端点统一带 `surface=any`；`test/pet.test.js` 用真 HTTP 服务器钉住这条。

### K14 · 限频把切换「吃掉」，而且切到 DSH 会冲掉类别
- 症状：旁观开着、采了 16 次，却只说过一次（还是第一拍的通用台词）；`lastSkip` 一直是 `rate-limited`。
- 原因一：`decideVisibility` 先判后说，被限频时直接 return，类别却已经记下 → 那个切换永远不会补说。
- 原因二：每次切到 DSH 看结果，都会把类别刷成 `other`；再切回 Word 是 `other→work`，被 D9 的规则判为「没换类型」。
- 对策：DSH 窗口透明化（D10）；限频时把台词记进 `pending`，额度回来且类别仍对得上就补说。

### K13 · 桌宠插件没挂进 bundles，窗口却是活的
- 症状：`/dsh-pet-7340/*` 回 404/405，但屏幕上明明有桌宠。
- 原因：`dsh-pet` 只在 profile 的 `dependencies` 里、不在 `dsh.profile.bundles` 里 → DSH 不挂它的宿主半侧；屏幕上的宠物是**上一个 DSH 进程遗留的孤儿 helper**（日志里 `config: http://127.0.0.1:<旧端口>/dsh-pet-7340/config`）。
- 对策：`plugin_manager set_bundle dsh-pet`（会即时生效，无需重启）；查证用宿主检查器按 name 过滤 Config，而不是看窗口在不在。

### K15 · 透明窗口按**像素**命中测试（v0.18）
- 症状：桌宠只有黑线能拖能点，线稿内部空白处没反应。
- 原因：全透明窗口的命中区域取决于**画了东西的像素**；把窗口染 1% 白能让整块可点，但立绘四周会出现「既不给人物、也不给下面应用」的死区。
- 对策：窗口保持 `.clear`，只给**命中矩形**铺极淡底色（现在 0.8%），矩形外点击穿透给下层应用。

### K16 · 无边框窗口默认 `canBecomeKey = false`（v0.22）
- 症状：F7 的输入面板出现了，但打不了字。
- 原因：`NSPanel` 无边框时不能成为 key window，键盘事件根本不会给它。
- 对策：`KeyPanel` 子类覆写 `canBecomeKey/canBecomeMain` 返回 true。

### K17 · 先画矩形再补三角，接缝处一定有横线（v0.22）
- 症状：气泡尾巴与矩形底边之间有一条可见横线。
- 原因：矩形的底边是一条完整的抗锯齿边，三角形叠上去也盖不住，不描边同样存在。
- 对策：画成**一条连续轮廓**（底边在尾巴开口处断开），而不是两个图元拼。

### K18 · `Number(x) || 默认值` 让输入框删不干净（v0.24）
- 症状：设置页的数字框删到只剩一位就删不动。
- 原因：`Number('')` 是 0（falsy）→ 立刻回填默认值；同理 `1` 也会被当成有效值继续保留。
- 对策：输入过程中只存**字符串**，保存时才解析并回落默认值。

### K19 · 日期字符串按 UTC 解析，东八区「今天」混进昨天（v0.25）
- 症状：选择「今天」筛选，把昨天的记录也带进来了。
- 原因：`toISOString().slice(0,10)` + `Date.parse('2026-11-07')` 都按 UTC；本地凌晨时 UTC 还在前一天。
- 对策：面板传**本地 0 点起算的完整时间戳**；宿主对纯日期字符串也按本地当天解释。

### K20 · 把「内容别被裁」实现成「窗口不许越界」会限制拖动（v0.25）
- 症状：加夹取后人物无法跨屏、也贴不到屏幕边缘。
- 原因：夹的是「窗口当前所在屏幕」，一夹住就锁死在那块屏。
- 对策：拖动时只夹**立绘**（按光标所在屏幕判断，跨屏照常），气泡/面板各自在显示时收边。

## 7.5 「目标判定」一类的设计约束（2026-11-07 复盘）

> 这一轮连续踩了 6 个坑，全部属于同一族：**我们读到的状态，被我们自己的副作用改掉了**，
> 或者**后一层兜底把前一层的正确判断抹掉了**。写在这里，是为了下次做新功能时不必重蹈。

### 约束 1 · 先读状态，再做副作用

`runLook` 原来的顺序是：弹气泡 → 读前台 → 截图。而弹气泡会把我们的 app 激活成前台，
于是「看一眼」看到的永远是上一个应用。

**规则：任何「要读取的环境状态」必须在第一次触碰 UI 之前快照下来，之后只用快照。**

```js
const frontSnapshot = await frontApp(ctx);   // 先拍
void say(ctx, '看一眼');                      // 再显示
await lookOnce({ ..., frontSnapshot });       // 后处理
```

适用：前台窗口、光标位置、选中文字、剪贴板、屏幕排列。

### 约束 2 · 分层兜底必须能被上层「否决」

选中文字是三层：`AXSelectedTextRange`（准）→ `AXSelectedText`（可能误报）→ ⌘C 剪贴板（最粗）。

Bug 的形态：AX 层已经明确判定「只有光标、没有选中」（`sawRange: true, sawCaret: true`），
但最后那层 ⌘C 兜底**无条件执行**，而 Obsidian / VS Code 在没有选中时会复制整行，
于是「光标」被重新捞成「选中」。修了三轮才在最后一层找到。

**规则：兜底链要显式传递「否决」信号，上一层说「确定没有」时，下一层不许再猜。**

```js
const explicitNoSelection = sawRange === true;   // 范围已明确、只是文本为空
if (text.isEmpty && !explicitNoSelection && allowCopy) { ... }
```

### 约束 3 · 每个判定都要带「来源」

没有来源，排查只能靠猜。现在 `selection` 返回 `source / sawRange / sawCaret`，
记录里带 `targetVia / targetWindowId / targetDesktop`，`/state` 带 `lastSelection`、
`buddyListeners`、`lastBuddyAction`。

**规则：新增一个「分支判定」时，同时把判定依据写进状态或记录，并在 UI 之外留一个可读入口。**

### 约束 4 · 坐标系与激活方式是两个独立的坑

| 坑 | 事实 | 后果 |
|---|---|---|
| 坐标系混用 | `CGEvent.location` 与 `CGWindowList` 的 bounds 都是**左上原点**；`NSEvent.mouseLocation` 是**左下** | 比较永远不命中 → 永远判成桌面 |
| 透明窗口命中 | 全透明窗口按**像素**命中测试 | 只有画了东西的地方能点；整窗染色会留下死区 |
| 无边框窗口 | `NSPanel` 无边框时 `canBecomeKey = false` | 面板可见但打不了字 |
| 显示激活 | `makeKeyAndOrderFront` 会**激活 app**；`orderFront` 不会 | 只显示不交互的窗口不要用前者 |

### 约束 5 · 「限制」加在需要它的那一刻，而不是常驻路径上

为了不让气泡被屏幕切掉，我把「窗口不许越界」加进了拖动逻辑——结果人物无法跨屏、
也贴不到屏幕边缘。正确做法：拖动自由，**在气泡要显示的那一刻**才收边。

### 新功能自检清单（6 条）

做完一个涉及「读取环境 + 显示 UI」的功能，问自己：

1. 我读的状态，会不会被我自己接下来弹出的窗口改掉？（→ 先快照）
2. 我的兜底链里，最后一层会不会把前一层的「确定否定」覆盖掉？（→ 传否决信号）
3. 出问题时，我要靠什么判断走了哪条分支？（→ 加来源字段）
4. 我用的坐标 API 是哪套原点的？窗口？屏幕？多显示器下还对吗？
5. 这个窗口需要键盘输入吗？需要才 `makeKey`，不需要就别抢焦点。
6. 我加的限制，有没有误伤用户对窗口的正常操作（拖动、跨屏、贴边）？

---

## 7.6 不做「持续的轻量监控」（2026-11-07 自查）

> 明确约束：**除了功能正在使用的那一刻，不要为了省事挂常驻轮询/监听。**
> 「开销很小」不是理由——它是持续唤醒、持续耗电，且会掩盖设计问题。

### 自查结果（2026-11-07）

| 位置 | 原周期 | 运行时机 | 处置 |
|---|---|---|---|
| 浮窗命令轮询 `Timer` | 250ms | 桌宠进程活着就一直跑 | ✅ 改为**目录事件驱动**（`DispatchSource`），另留 5s 兜底 |
| 浮窗气泡隐藏 | 每 250ms 检查时间到没到 | 同上 | ✅ 改为**一次性定时器**（到点才醒） |
| 旁观采样 `setInterval` | 10s | **关闭时也创建**（空转 return） | ✅ 关闭时不建定时器 |
| 旧热键链路（Electron/桥常驻） | 常驻进程 + `fs.watch` | 浮窗已注册热键时仍在跑 | ✅ 浮窗启用时不启动这条老链路 |
| 页内 HUD 轮询 | 3s | **页面一加载就跑**（hud 默认关也跑） | ✅ v0.37.0 整个 HUD 删除，客户端 0 定时器 |
| SSE 心跳 | 25s | 仅连接期间 | ✅ 保留（保活必需） |

### 换成事件驱动后必须注意的事

命令文件**必须原子写入**（写临时文件再 `rename`）。目录事件只在「条目创建/删除/改名」时触发，
直接往既有文件里写内容**不会**唤醒监听方——它只能等 5 秒兜底，表现为「气泡慢了」。

插件的 `writeJsonAtomic` 本来就是 rename，所以正常；手工测试时要记得用 rename。

### 判断标准（写在这里，以后新增功能照着做）

1. 没有活动功能时，进程应当是**完全空闲**的：0 定时器、0 轮询、0 文件扫描。
2. 需要感知变化时，优先**事件驱动**（`DispatchSource` / `fs.watch` / SSE），其次才是低频兜底。
3. 兜底定时器必须有 `tolerance`（允许系统合并唤醒）并且间隔 ≥ 5s。
4. 定时器必须跟生命周期绑定：关闭、卸载、失焦时要清掉。
5. 客户端轮询只允许出现在「某个界面打开期间」，不允许在插件加载时就跑。
6. **需要跟随「前台是谁」时，用系统的应用激活通知**（`NSWorkspace.didActivateApplicationNotification`），
   不要写"每 N 秒查一次前台"。一次 `frontapp` 查询要起子进程、实测 150–240ms，
   1.2 秒一次约等于占一个核 15%（v0.61 踩过，v0.62 改成事件驱动）。
   已知盲区：同一应用内切窗口不触发激活通知，所以「最终锁定」必须在按下按钮那一刻再取一次。

---

## 8. 测试与验收基线

```
node test/policy.test.js          # 30 项：黑名单 / 静默 / 限频 / 场景签名 / 脱敏 / 配置归一化
node test/client.test.js          #  8 项：客户端契约（假 __ModuleLoader__ + 假 react）
node test/history.test.js         # 11 项：存取 / 统计 / 清理 / 范围边界（含本地时区回归）
node test/chat.test.js            #  5 项：追问的消息构造与预算
node test/seed.test.js            #  7 项：会话种子事件与首条消息模板
node test/plugin.test.js          # 14 项：注册形状（严格 getter + inject 回归）+ 真跑原生桥
node test/decoupling.test.js      #  4 项：不再依赖 dsh-pet（源码扫描）
node test/pack.test.js            #  7 项：按 files 复制「发布包」再试装
node test/hotkey.test.js          #  4 项：热键解析与门禁
node test/hotkey-bridge.test.js   #  1 项：桥的热键事件消费
```

合计 **91 项**，2026-11-07 全绿。

端到端验收（当前状态）：

| 场景 | 状态 |
|---|---|
| 看一眼（F8 / 点桌宠） | ✅ 文本与截图两条路都通，桌面/整屏也有明确分支 |
| 看一眼并提问（F7 / 双击桌宠） | ✅ 浮窗多行输入面板；取消不花钱、空输入按 F8 |
| 全局热键 | ✅ 由浮窗进程注册（Carbon），设置页可录制修改 |
| 气泡 / 输入面板 | ✅ 跟随人物、跟随主题；贴边时收边 |
| 陪伴记录面板 | ✅ 搜索 / 范围 / 追问 / 开会话 / 右键多选 / 批量删除 |
| 用记录开新会话 | ✅ 种子里带图与原文，首轮真实跑完（`blank` 变 false） |
| 旁观主动说话 | ⏸ 默认关，代码保留 |
| 快捷键录制（设置页） | ⏳ 待实机确认（v0.27.3 改动） |

---

## 9. 文件地图（v0.42.0，节选）

```
dsh-companion/
├── cordis.patch.yml          # bundle 挂载（id 必须 = 包名）
├── package.json              # dsh.bundle.patch + dsh.client + exports + files
├── README.md / DEVLOG.md / ROADMAP.md / CHANGELOG.md
├── docs/                     # 功能清单 / 逐版本历史 / 实验数据（见第 11 节）
├── bridge/
│   ├── DshBridge.swift       # 原生桥：windows / frontapp / idle / pdftext / axtext /
│   │                         #   selection / trust / poke / hotkeys / ask / pickfile
│   ├── build.sh              # 出 arm64+x86_64 通用二进制
│   └── bin/dsh-bridge        # 编译产物（发布必需）
├── buddy/
│   ├── Buddy.swift           # 自绘桌宠：立绘 / 气泡 / 输入面板 / 右键菜单 /
│   │                         #   拖拽与位置记忆 / Carbon 全局热键 / 单实例 flock
│   ├── build.sh              # 同上，链接 Carbon
│   └── bin/dsh-buddy         # 编译产物（发布必需）
├── assets/buddy/character.png# 默认立绘（可被设置页的 buddy.asset 覆盖）
├── lib/
│   ├── index.js              # apply()：配置 / 路由 / 工具 / 命令 / 热键 / 浮窗看护
│   ├── config.js             # 默认值 + 纠错告警（无 schema）+ settings.json 覆盖
│   ├── native.js             # 碰系统的唯一入口（桥调用、screencapture、osascript）
│   ├── http.js               # node:http 客户端（替代 fetch）
│   ├── policy.js             # 纯策略：黑名单 / 静默 / 限频 / 签名 / 桌面判定
│   ├── adapters.js           # Word / Zotero / PDF / 浏览器 读取适配器
│   ├── look.js               # 看一眼主流程：抓取 → 模型 → 气泡 → 落记录
│   ├── chat.js               # 记录上的追问（稳定前缀 + 缓存）
│   ├── seed.js               # 用记录种一个新会话（事件构造 + 首条消息模板）
│   ├── history.js            # history.jsonl 存取 / 统计 / 清理 / 范围边界
│   ├── surface.js            # 输出面抽象（say / playAnim），现在由浮窗实现
│   ├── buddy.js              # 浮窗进程看护 + 文件 IPC + 提问桥
│   ├── hotkey.js             # Electron/桥两种热键注册（历史保留，现由浮窗注册）
│   ├── observer.js           # 旁观采样（默认关，代码保留）
│   ├── tools.js              # 工具定义（含 companion_say / companion_last_capture）
│   ├── prompt.js             # 系统提示词唯一组装点（人设 → 规则 → 优先级声明）
│   ├── persona.js            # persona.md 读写 + 缓存
│   ├── collect.js            # 多画面收集状态机
│   └── client.js             # 陪伴记录面板 / 设置页 / SSE / 客户端版本上报
├── locale/                   # 文案
└── test/                     # 14 套，125 项
```

---


---

## 10. 变更记录（已归档）

逐版本记录太多（124 条），单独放在 [`docs/devlog-history.md`](docs/devlog-history.md)：新版本追加在文件最前面。
这里只保留每个阶段的**结论**——想追细节去那个文件。

---

---

## 11. 文档结构（改动前先看这里）

| 文件 | 角色 | 写什么 / 不写什么 |
|---|---|---|
| `README.md` | 对外说明 | 装、权限、能做什么；不含实现细节 |
| `docs/FEATURES.md` | **功能清单** | 现有哪些能力、入口、代码位置、测试；回答"这玩意有吗" |
| `CHANGELOG.md` | 里程碑更新日志 | 面向使用者，按版本段归纳；不写逐条修复 |
| `docs/devlog-history.md` | 逐版本历史 | 124 条 `### vX.Y.Z`，倒序；**新版本追加在最前面** |
| `DEVLOG.md`（本文件） | 开发日志 | 设计取舍、踩过的坑、验收基线、文档规则 |
| `ROADMAP.md` | 路线 | 当前状态快照、已知问题、下一步 |
| `docs/watch-experiment.md` | 实验数据 | 「看一阵」的离线结论（不是计划） |
| `docs/EXTERNAL-REFERENCES.md` | 外部项目参考 | 12 个项目的核心机制、我们采纳/否掉的点与原因 |
| `docs/AUDIO-DESIGN.md` | 音频设计稿 | 三条采集路径、ASR 选型、隐私与分期（未实现） |
| `docs/MAINTENANCE.md` | 线上维护 | 线上/本地同步点、发版清单、线上待办（不含功能细节） |

约定：

0. **`CLIENT_VERSION` 只在改了 `lib/client.js` 时升**；宿主-only 发版可以滞后（测试只保证"不得新于包版本"）。
   改了客户端却没升它 = 用户的界面会一直是旧的且没有提示。


1. 发版时**两处都要写**：`docs/devlog-history.md` 加一条 `### vX.Y.Z`（含原因与验证），`CHANGELOG.md` 只在里程碑处归纳。
2. 功能增删改后同步 `docs/FEATURES.md`——它是"现在有什么"的唯一答案。
3. 测试项数变化时，更新第 8 节基线与 `docs/FEATURES.md` 的测试矩阵。
4. 面向用户的话术里**不出现"刷新页面"**：这个客户端只有关闭重启。
