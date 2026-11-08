# dsh-companion-journal

自带桌宠的**感知与协同层**：一个由插件自己画的立绘浮窗，加上一套「看一眼」的抓取、模型调用与陪伴记录。

不依赖任何第三方桌宠插件——浮窗进程（`buddy/dsh-buddy`）是我们自己编的原生 AppKit 程序：

```
模型 ──工具──> dsh-companion-journal ──原生桥──> macOS（窗口 / 截图 / 选中文字）
                    │
                    └──气泡──> dsh-buddy（静态立绘 + 气泡 + 右键菜单）
```

## 文档导航

| 文档 | 内容 |
|---|---|
| [docs/FEATURES.md](docs/FEATURES.md) | 现在有哪些功能、从哪进、代码在哪 |
| [docs/PRIVACY.md](docs/PRIVACY.md) | 读什么、存哪、怎么删、怎么收回权限 |
| [CHANGELOG.md](CHANGELOG.md) | 里程碑级更新摘要 |
| [docs/devlog-history.md](docs/devlog-history.md) | 逐版本记录（124 条） |
| [DEVLOG.md](DEVLOG.md) | 设计取舍、踩过的坑、验收基线 |
| [ROADMAP.md](ROADMAP.md) | 当前状态、已知问题、下一步 |
| [docs/watch-experiment.md](docs/watch-experiment.md) | 「看一阵」可行性实验数据 |
| [docs/EXTERNAL-REFERENCES.md](docs/EXTERNAL-REFERENCES.md) | 外部项目参考：机制、采纳与弃用理由 |
| [docs/AUDIO-DESIGN.md](docs/AUDIO-DESIGN.md) | 音频方案设计稿（未实现） |
| [docs/audio-and-speech-ideas.md](docs/audio-and-speech-ideas.md) | 听 / 说的设计笔记（归档，未做） |

## 装之前先看这段

这个插件和普通「纯前端插件」不一样：**它的能力上限由三个系统权限决定**，而权限只能你亲手点。

| 权限 | 用来做什么 | 不给会怎样 |
|---|---|---|
| 屏幕录制 | `screencapture`、窗口标题 | 截不了图；`companion_windows` 里所有窗口没标题 |
| 辅助功能（可选） | 跨应用读焦点文本 | 只有 Word / PDF / Zotero 能读，其它应用只给窗口信息 |
| 自动化（按应用） | 用 AppleScript 读 Word / Preview / Skim | 那几个应用读不到正文 |
| Zotero 本地 API（应用内开关） | 查文献条目 | Zotero 适配器不可用 |

授权归属是 **DeepSeek Harness.app**，在 `系统设置 → 隐私与安全性` 里勾选，**勾完必须重启应用**。
授权没给时插件不会静默失败：工具会返回「去哪点哪个开关」，`/state` 里也能看到 `bridge.ok`。

读什么、存在哪、怎么删，见 [docs/PRIVACY.md](docs/PRIVACY.md)。

## 安装

要求：**macOS 11+**（Apple Silicon / Intel），DSH **0.2.2-rc.1+**。这个包只声明 macOS；
Windows / Linux 会被宿主直接拒绝安装，不会装出一个没有气泡的半成品。

### 从 GitHub 安装（推荐）

图形界面：

1. 左侧栏「**插件**」→ 右上「**添加插件**」→「**安装第三方插件**」
2. 「包名或地址」填 `github:DarkAnJ/dsh-companion-journal`
3. 装完**完全退出并重开** DeepSeek Harness（宿主半侧代码只在启动时加载）

命令行（DSH 0.2.1+ 的桌面端 CLI 可管理 `desktop` profile；如果你的版本仍提示
profile 被应用独占，就用上面的图形界面）：

```bash
dsh plugin --profile desktop add github:DarkAnJ/dsh-companion-journal
```

### 用预编译包安装（不需要 Xcode）

在「包名或地址」里填发布包地址：

```
https://github.com/DarkAnJ/dsh-companion-journal/releases/latest/download/dsh-companion-journal.tgz
```

这是 `npm pack` 产出的发布包，原生桥与浮窗二进制已带 arm64 + x86_64 通用切片，
安装时不会编译任何东西，也不会有构建授权弹窗。

### 本地开发

「包名或地址」填本目录的**绝对路径**（例：`/Users/你/code/dsh-companion-journal`）。
原生桥改动才需要重编（仓库里已带通用二进制）：

```bash
bash bridge/build.sh   # 需要 Xcode Command Line Tools
```

### 从旧的 dsh-companion 升级

1. 先在插件页卸载旧的 `dsh-companion`；
2. 按上面的方式安装 `dsh-companion-journal`；
3. 重启 DSH。插件启动时会把 `~/.dsh/dsh-companion/` 整体迁移到
   `~/.dsh/dsh-companion-journal/`，并在旧路径留一个符号链接，已配好的快捷指令继续可用；
4. 如果你在 `cordis.patch.yml` 里手写过 `- id: dsh-companion`，把 id 改成
   `dsh-companion-journal`（插件不能安全地代改宿主配置）。

`~/.dsh/dsh-companion-journal/` 里是历史记录、人设、提示词、立绘缓存与热键事件；
卸载插件不会删除它，重装后继续可看。

### 换立绘

只需要一张 **PNG 立绘**：

| 项 | 要求 |
|---|---|
| 格式 | PNG（带透明通道，背景必须是透明的，否则会是一个方块） |
| 尺寸 | 建议 **256×256** 或 192×192 正方形；非正方形也能用，会按 160×160 拉伸 |
| 内容 | 人物尽量占满画面、四周留一点空白（气泡会贴着顶部出现） |
| 像素风 | 用**整数倍**放大的 PNG（如 32×32 → 256×256），浮窗按最近邻绘制，边缘不会被糊掉 |

两种用法：

1. 配置 `buddy.asset` 指向你的图（支持 `~`），插件启动时复制到 `~/.dsh/dsh-companion-journal/assets/` 再用
2. 直接替换包里的 `assets/buddy/character.png`

改完重挂插件即可生效（文件 mtime 变了会自动重新同步）。

### 桌宠浮窗

插件启动时会拉起 `buddy/bin/dsh-buddy`（原生 AppKit 进程），并把立绘与二进制同步到
`~/.dsh/dsh-companion-journal/` 下再运行——直接从 `~/Documents` 拉起会被 TCC 拦。

- 左键点立绘 = 看一眼；右键 = 看一眼 / 陪伴记录 / 隐藏 / 退出桌宠
- 气泡显示最近一次评语，点气泡会打开陪伴记录并定位到那条
- 浮窗崩了会自动重启（1s、2s、4s… 退避）；它没起来时 F7/F8 照常完成，只是没有气泡
- 位置记在 `~/.dsh/dsh-companion-journal/buddy.state.json`

关掉浮窗（配置 `buddy.enabled: false`）不影响任何抓取与记录功能。

## 给别人用（分发）

这个包**已经是可分发的形态**：单包、零 npm 运行时依赖、不需要构建步骤就能加载
（`lib/` 里就是最终代码），`bridge/bin/` 与 `buddy/bin/` 都是 arm64 + x86_64 通用二进制。

目前的主渠道：

| 渠道 | 用户操作 |
|---|---|
| 插件市场（收录后） | 搜索 `dsh-companion-journal`，一键安装 |
| GitHub 源码 | 安装源填 `github:DarkAnJ/dsh-companion-journal` |
| GitHub Release 预编译包 | 安装源填 `https://github.com/DarkAnJ/dsh-companion-journal/releases/latest/download/dsh-companion-journal.tgz` |
| npm（可选） | `dsh plugin --profile desktop add dsh-companion-journal` |

维护者发布前跑一次：

```bash
node test/pack.test.js   # 真的 npm pack 一份发布包，再从带空格的路径里试装
node test/identity.test.js  # 包名 / patch id / 客户端 id / 路由必须一致
```

### 平台与架构

| 平台 | 状态 |
|---|---|
| macOS 11+（Apple Silicon / Intel） | 6 个工具全部可用 |
| Windows / Linux | 不支持：`dsh.bundle.platforms` 声明了 `darwin`，宿主会拒绝安装 |

原生桥是 **universal 二进制**（arm64 + x86_64），Intel Mac 不用自己编。
如果是用浏览器下载 Release 压缩包再解压安装，macOS 会给文件打隔离标记：

```bash
xattr -dr com.apple.quarantine <插件包目录>
```

### 别人需要自己准备什么

### 别人需要自己准备什么

1. **DSH** 本体（`dsh-bundle.patch` 由安装流程处理，不用手动改 profile 配置）。
2. 不需要装任何第三方桌宠插件——浮窗由本包自带（`buddy/bin/dsh-buddy`，通用二进制）。
3. **系统权限**（同上表）。这些没法由插件代劳，也无法自动化授权。
4. **Zotero 本地 API 开关**（只影响 Zotero 适配器）。

## 它给你六个工具

| 工具 | 什么时候用 |
|---|---|
| `companion_windows` | 不知道用户在干什么：列窗口，拿 `windowId` |
| `companion_read` | 「看看我现在写/看的这个」：文本优先地读前台窗口 |
| `companion_capture` | 需要看见图：截前台窗口 / 指定窗口 / 整屏 |
| `companion_watch` | 开关旁观、查看状态与「上次为什么没说话」 |
| `companion_say` | 让桌宠把结论说出来（不调模型、不花钱） |
| `companion_last_capture` | 取「最近一次抓取」，用户说「刚才那个」时不用猜窗口标题 |

外加一个斜杠命令：`/companion status|start|pause|once`。

### 为什么不直接截图，先读文本

因为文本更准。Word 的 `content of active document` 是文档真实字符；截图再让模型 OCR 一遍，
会在公式、脚注、双栏排版上出错，还更慢更贵。只有拿不到文本的窗口（视频、画布、扫描件）
才走 `companion_capture`。

## 旁观是怎么工作的

不是录屏，是**采样**：前台窗口一换，就让桌宠说一句。

```
每 5s 读一次「前台应用 + 窗口标题 + 空闲秒数」
      → 压成场景签名，没变就什么都不做
      → DSH 自己的窗口是透明的：切过来看聊天不算换场景
      → 换就过闸：黑名单与敏感词 / 静默时段 / 频率上限（20s 一句）
      → 全过就让桌宠说一句（台词来自固定短句池，不调模型）
```

**它说的不是「你在看什么」，而是「我注意到你换了」**：

```
又换啦？
我跟过来了。
这个我也在看着。
嗯，你忙你的。
换地方也不说一声。
我在这儿呢。
```

原因很简单：「从 Word 切到 Safari」这种话对你是零信息量——你自己刚切的。
台词池不含任何应用名或文档名，所以也不存在从标题泄露内容的问题；相邻两句不会重复。

默认节奏：采样 5s、两句之间至少 20s、每小时最多 60 句、`23:00–08:00` 静默。

### 热键：按一下就让它看一眼（推荐入口）

默认 **`option+shift+L`**（可在配置的 `hotkey.spec` 里改，如 `command+alt+space`、`F8`）：

```
按热键
 ├─ 有选中文字（AXSelectedText）→ 只处理这段文字（文本路径，便宜且准）
 └─ 没有选中 → 截当前前台窗口（跳过桌宠/DSH）→ 视觉路径
        ↓
   当前模型给一句 ≤40 字的反馈 → 桌宠说出来
```

热键的实现分两级：宿主若暴露 Electron `globalShortcut` 就用它（零新进程）；实际桌面端的宿主是普通 Node 进程，拿不到它，于是退回 **桥的常驻监听**（`dsh-bridge hotkeys`，一个约 13MB 的 Swift 进程，空闲 0 CPU、按 Carbon 事件唤醒、不抢焦点）。两条路对外行为一致，`/state` 的 `hotkey.backend` 会写明当前用的是 `electron` 还是 `bridge`。

抓到的内容会留一份「最近一次抓取」，之后在对话里说「刚才那个」时，模型会用 `companion_last_capture` 取它，**不靠猜窗口标题**。

未授权辅助功能时，选中文字读不到（会明确提示），自动退化为「只看窗口」。

### 把一条记录开成新会话

面板里每条记录右侧有「开新会话」：以这条记录的**原图 + 当时的评语**为种子，在你选定的工作区里新建一个 DSH 会话，并且**立刻跑一轮**，所以打开就能看到它对这张图的解读，接着聊就行。

两个实现约束（写死在代码里，改之前先看 DEVLOG v0.11.1）：

- DSH 侧边栏只显示 `blank=false` 的会话，所以**必须真的跑过一轮**，只种一条消息的会话是看不见的
- `agents.create` 必须带 `agentOptions: { provider, model }`，否则这一轮会报 `agent has no provider/model`

代价：点一次 = 一次带图的模型调用。

### 用 macOS 快捷指令绑热键（默认模式）

`hotkey.mode: 'shortcut'` 下，插件不拉任何常驻进程——热键由系统「快捷指令」触发：

1. 快捷指令 App → 新建 → 添加「运行 Shell 脚本」
2. 脚本：

```sh
<包目录>/bridge/bin/dsh-bridge poke --events "$HOME/.dsh/dsh-companion-journal/hotkey.events"
```

3. 快捷指令详情 → 添加键盘快捷键（如 ⌥⇧L）

按下后：插件监听到事件 → 有选中读选中文字，没有就截当前窗口 → 模型看一眼 → 桌宠说一句。
不需要任何 TCC 授权做热键；辅助功能只影响「能不能读到选中文字」。

### 选中文字怎么读（跨应用）

按热键时先试着读**你选中的文字**，读不到才截图。三层依次退：

| 层 | 手段 | 适用 |
|---|---|---|
| 1 | `AXSelectedText` | 原生输入框、Notes、Word 等 |
| 2 | `AXSelectedTextRange` + `AXStringForRange` | 浏览器网页内容（Safari / Chrome 的 WebArea） |
| 3 | **⌘C + 剪贴板**（先快照、读完还原） | 微信、Electron 应用等自绘界面 |

所以微信里选中一条消息按热键，它读的是**那条消息的文字**，历史里也只有文字、没有截图。
`/state` 的 `lastSelection.via` 会写明用的是 `ax` 还是 `clipboard`。

副作用只有一条：走第 3 层时剪贴板会被改写约 0.1–0.4 秒，随后按原内容还原（含非文本类型）。

### 「看一眼」长在宠物身上

**右键点桌宠 → 菜单里选「看一眼」**。它会：

1. 找到你**刚才在用的那个窗口**（不是 DSH，也不抢你的焦点）
2. 按 windowId 后台截一张图（不激活目标应用，你的 Word 不会被顶下去）
3. 让当前模型看一眼，说一句有内容的话（≤40 字），由桌宠念出来

这条路的入口在宠物身上，所以**在任何应用里都点得到**——写 Word 时右键它就行。
热键（默认 F8）、桌宠左键、右键菜单里的「看一眼」走的是同一条采集路径。

失败时会明说原因：`没有屏幕录制授权` / `当前模型不支持图片输入` / `你刚才没有别的窗口`。

### 旧的「看一眼」含义

点了它，桌宠会说一句「**刚才（30 秒前）你在 Safari「bilibili」**」——注意是**刚才**，不是现在。

因为热键在 DSH 窗口里按下时前台必然是 DSH 自己，重新采样只能采到自己。所以它回看的是
**最近一次「别处」的采样**，顺带告诉你：它到底有没有在正常看。
如果它说「我还没看到你在别的地方做什么」，说明后台采样没在跑。

## 配置

写进 `~/.dsh/profiles/desktop/cordis.patch.yml`（或让插件页改），下次启动生效：

```yaml
- id: dsh-companion-journal
  name: 'dsh-companion-journal'
  config:
    hotkey:
      enabled: true               # 关掉就完全不注册（零开销）
      spec: 'option+shift+L'      # 修饰键 command/option/control/shift + 键名或 F1-F19
    pet:
      id: main                    # 用哪只桌宠（配错会自动挑第一只）
    observe:
      enabled: false              # 默认关：先自己确认旁白节奏能接受
      intervalMs: 5000            # 采样间隔：切换后最多 5s 被注意到
      minGapSec: 20               # 两句之间至少 20s
      maxPerHour: 60
      quietHours: ['23:00-08:00']
      denyApps: ['1Password', 'Keychain Access', 'Mail', '钱包', '银行']
      denyTitlePatterns: ['password', '密码', '身份证', '银行卡']
    capture:
      maxWidth: 1600              # Retina 截图先缩到这个长边，再交给模型
    read:
      maxChars: 12000
      zotero:
        enabled: true             # 还需要在 Zotero 里开本地 API
        baseUrl: 'http://127.0.0.1:23119'
    privacy:
      redact: ['学号']            # 读到的文本按这些词脱敏
      pauseOnSensitiveTitles: true
```

配置写错不会让插件消失：类型不对的键会被忽略、并写一条 `[dsh-companion-journal] 配置：…` 告警。

## 已知边界

- **只读，不代点。** 不做鼠标键盘模拟，不点按钮、不填表。误点的代价太高。
- **浏览器只有元信息。** 读网页正文需要浏览器扩展桥（P4，尚未实现）；现在 `companion_read`
  对 Chrome/Safari 只返回标题，并明确说「正文需要扩展桥」。
- **只能读前台窗口。** 指定窗口读取要等 P4。
- **Zotero 靠窗口标题匹配条目。** 拿不到标题（没授屏幕录制）时会让你直接说作者/标题。
- **辅助功能路径是实验性的。** 只读焦点元素，不做整窗遍历（大文档会卡）。
- **Word 只读，不写。** 需要改稿请用 office 技能。
- **结果都在「陪伴记录」面板里。** 侧边栏入口，可搜索、可按时间筛、可追问；多画面记录收成一张卡片。

## 排障

| 现象 | 原因与处理 |
|---|---|
| `/state` 里 `bridge.ok` 为 false | `bash bridge/build.sh`；缺 swiftc 就 `xcode-select --install` |
| 截图报「没有屏幕录制授权」 | 系统设置 → 隐私与安全性 → 屏幕录制 → 勾 DeepSeek Harness → **重启应用** |
| Word 报「自动化授权被拒绝（-10004）」 | 系统设置 → 隐私与安全性 → 自动化 → 允许 DeepSeek Harness 控制 Microsoft Word |
| 窗口列表全是「(无标题)」 | 同上，缺屏幕录制授权 |
| Zotero 报「连不上本地 API」 | Zotero → 设置 → 高级 → 勾「允许此计算机上的其他应用程序与 Zotero 通信」 |
| `/companion once` 说没开口 | 看返回的 `lastSkip.reason`：`sensitive-title` / `deny-app` / `quiet-hours` / `rate-limited` / `pet-unavailable` |
| 切了应用它也不说话 | 看 `lastSkip.reason`：`self-window`（你在 DSH 里）、`rate-limited`（20s 内只给一句）、`quiet-hours`（静默时段）或 `pet-unavailable`（桌宠没挂上） |
| 桌宠浮窗没出现 | 看 `/companion status` 里的 `buddyRunning`；为 false 时查 `~/.dsh/dsh-companion-journal/bin/dsh-buddy` 是否同步成功 |
| `companion_say` 报成功但没气泡 | 浮窗进程没起来（同上），或 `buddy.say.json` 写入失败（看日志） |

## 自测

```bash
npm test                    # 18 套 / 177 项
node test/identity.test.js  # 包名 / patch id / 客户端 id / 路由必须一致
node test/migrate.test.js   # 旧数据目录迁移、符号链接、幂等
node test/pack.test.js      # 真跑 npm pack，解到带空格的路径里再加载
```

`plugin.test.js` 会真的调用系统桥：在没授权的机器上，截图与 Word 两项断言的是
「失败信息是否给出了正确的授权指引」，而不是成功。
`pack.test.js` 是给「别人能不能装」兜底的：它真的跑一次 `npm pack`，把 tarball
解到**带空格的路径**里，再从那里加载插件 —— `files` 漏写一条就会当场失败。

## 设计笔记

- **`apply()` 绝不抛异常。** 插件是 required，抛错会让 DSH 进安全模式并重写 profile —— 一个配置笔误的代价是插件消失。
- **截图走 `finalizeContent`。** `output.schema` 是严格 JSON，图片塞不进返回值；附件必须在 `execute` 里存好，`finalizeContent` 只做同步挂载。
- **起进程走 `ctx.subprocess`。** 裸 `node:child_process` 在宿主沙箱里会 `EPERM`（管道 stdio）。
- **HTTP 用 `node:http` 不用 `fetch`。** `fetch` 在 Node 18+ 才有，一次 `fetch is not defined` 会让「让桌宠说话」静默失效，症状看起来像「桌宠没装」。

还要往下看的话：[DEVLOG.md](DEVLOG.md) —— 实测过的事实、**尚未验证的假设**、踩过的坑、以及未定事项与决策记录。

MIT.
