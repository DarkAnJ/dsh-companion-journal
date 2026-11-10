# dsh-companion-journal

[![Release](https://img.shields.io/github/v/release/DarkAnJ/dsh-companion-journal?label=release)](https://github.com/DarkAnJ/dsh-companion-journal/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%2011%2B-111111)](#安装要求)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**给 DeepSeek Harness 的自绘桌宠 + 屏幕感知插件。** 按一下热键，它看一眼你正在做的事，说一句话；
想看得细，还能录一段并整理成带时间线的记录。所有内容留在本机。

不依赖任何第三方桌宠插件：桌宠浮窗是插件自带的原生 AppKit 程序（`buddy/bin/dsh-buddy`），
截图、窗口信息、选中文字由 Swift 写成的桥（`bridge/bin/dsh-bridge`）提供。

```
当前模型 ──工具──> dsh-companion-journal ──原生桥──> macOS（窗口 / 截图 / 选中文字）
                          │
                          └──气泡──> dsh-buddy（立绘 + 气泡 + 右键菜单）
```

## 功能

| 功能 | 入口 | 做什么 |
|---|---|---|
| 看一眼 | 右键菜单 / 自定义热键 / 左键点桌宠 | 后台截取你刚才在用的窗口，让模型说一句 ≤40 字的评语，桌宠念出来 |
| 看一眼并提问 | 右键菜单 / 自定义热键 | 截取当前窗口并弹输入框，带着这张图继续聊 |
| 看几眼 | 右键菜单 / 自定义热键 | 连续采集多张画面，最后一起分析（气泡上有「结束并看 / 提问 / 取消」） |
| 看一阵 | 右键菜单 / 自定义热键 | 对某个窗口连续采样并逐段总结，可暂停、可换采样率；每段会出一句模型输出，也能出拼图 |
| 陪伴记录 | 右键菜单 / 侧边栏 / 自定义热键 | 搜索、按时间筛选、追问、对记录「开新会话」、多选批量删 |
| 桌宠 | 常驻 | 自绘立绘、气泡说话、右键菜单、拖动与位置记忆、全局热键 |

- 抓不到文字时才看图：Word、PDF、网页正文优先读文本，视频/画布/扫描件才走截图。
- 截图不激活目标应用：按了热键，你的 Word 不会被顶到前台。
- 记录里同时留存文字与图片，追问和开新会话都能带图。
- **每个功能都能从桌宠右键菜单进入**；热键都可以在设置页里自定义，表中不写死具体组合，避免和你的其它工具冲突。
  （少数热键仍在补齐，设置页里能绑定哪些以实际显示为准。）

## 安装要求

| 项 | 要求 |
|---|---|
| 系统 | macOS 11+（Apple Silicon / Intel，二进制为 universal） |
| DeepSeek Harness | `>= 0.2.1-rc.1 < 0.3.0`（0.2.2-rc.1 实测通过） |
| 其他平台 | 不支持：插件声明了 `darwin`，Windows / Linux 会被宿主拒绝安装 |

## 安装

**方式一：Release 预编译包（推荐，不需要 Xcode）**

在 DSH 的「插件」页 →「添加插件」→「安装第三方插件」，填入：

```
https://github.com/DarkAnJ/dsh-companion-journal/releases/latest/download/dsh-companion-journal.tgz
```

**方式二：从 GitHub 源码安装**

```
github:DarkAnJ/dsh-companion-journal
```

命令行等价写法：

```bash
dsh plugin --profile desktop add \
  https://github.com/DarkAnJ/dsh-companion-journal/releases/latest/download/dsh-companion-journal.tgz
```

装完**完全退出并重开 DeepSeek Harness**（宿主代码只在启动时加载）。

### 升级

重复上面的安装步骤覆盖即可，配置与记录不受影响。

### 卸载

在插件页卸载即可。`~/.dsh/dsh-companion-journal/` 里的记录、人设与立绘不会被删除，重装后继续可用。

## 首次使用：权限

插件的可用程度由系统权限决定，权限只能你亲手授予（授权归属是 **DeepSeek Harness.app**）：

| 权限 | 用途 | 不授的后果 |
|---|---|---|
| 屏幕录制 | 截图、窗口标题 | 截不了图，窗口列表没有标题 |
| 辅助功能（可选） | 跨应用读取选中的文字 | 只能读到部分应用的文字，其余退化为只看窗口 |
| 自动化（按应用，可选） | 读取 Word / Preview / Skim 的正文 | 这几个应用只能看到窗口信息 |
| Zotero 本地 API（应用内开关，可选） | 读取文献条目 | Zotero 适配不可用 |

路径：`系统设置 → 隐私与安全性`，勾选后**重启 DSH**。

装好后在 `设置 → 陪伴桌宠 → 权限` 里可以直接看到三项状态：

- **请求授权**：触发 macOS 的系统授权框（屏幕录制 / 辅助功能）。系统框只在第一次或用户明确请求时出现；如果之前拒绝过，系统不会反复弹，只能手动去设置里勾。
- **打开设置**：直接跳到 `隐私与安全性` 里对应的面板，不用自己找。
- **刷新状态**：重新查询，不弹窗。
- 自动化按应用授权，首次读取 Word / Preview / Skim 时由系统弹窗；卡片里也给了直达入口。

授权后必须**完全退出并重开 DeepSeek Harness**，TCC 身份才会重新加载。

## 使用

所有功能都能从**右键点桌宠**弹出的菜单里进入；下面按功能说明。

### 看一眼

后台截取你刚才在用的窗口（不是 DSH 自己，也不抢焦点），交给当前模型，桌宠说一句 ≤40 字的评语。
失败会说明原因：没有屏幕录制授权 / 当前模型不支持图片输入 / 你刚才没有别的窗口。

### 看一眼并提问

截取窗口并弹出输入框，问题与图片一起发给模型，回答直接进入当前会话。

### 看几眼

按一次开始收集，之后每次「看一眼」往这一组里加一张；气泡上选「结束并看」，这组画面会一起分析。

### 看一阵

右键菜单 →「看一阵」：

1. 气泡立刻出现，按钮是「开始」；此时里面的应用名会**跟着你切换应用实时更新**；
2. 按「开始」后正式采样，按钮变成「暂停」，暂停后变成「继续」；
3. 采样率可在气泡上选择（1 / 2 / 5 / 10 / 20 秒），改完下一拍生效；
4. 每段结束会生成一句模型输出，点气泡上的「段 ▸」可以展开，边录边看它理解得对不对；
5. 想主动留一帧，点气泡上的「记一帧」——立刻抓一张，不用等下一个采样周期；
6. 「停止」后生成一条带时间线的记录，「丢弃」则不保存。

停止后记录里可以看到每段的起止时间、摘要、画面拼图，以及哪些时间段画面没有变化。

### 陪伴记录

侧边栏的「陪伴记录」：搜索、按时间筛选、逐条追问（带图）、对某条记录「开新会话」、
多选批量删除。多图记录以宫格展示，可切换大图。

### 设置

设置页里可改：人设、提示词全文、立绘、浮窗尺寸与字号、全局热键、重置桌宠位置。

## 数据与隐私

- 所有数据都在本机 `~/.dsh/dsh-companion-journal/`：记录、图片、拼图、人设、提示词、配置、热键事件。
- 插件不上传任何内容；只有在你触发「看一眼 / 提问 / 看一阵」时，才把当次内容发给**你当前配置的模型**。
- 「看一阵」可按窗口锁定（默认），桌面背景触发时只采集光标所在那块屏幕。
- 数据删除：删除该目录即可；或在陪伴记录里单条删除。

更细的说明见 [docs/PRIVACY.md](docs/PRIVACY.md)。

## 配置

配置写在 `~/.dsh/profiles/desktop/cordis.patch.yml`（或通过插件页修改），改完重启生效：

```yaml
- id: dsh-companion-journal
  name: 'dsh-companion-journal'
  config:
    buddy:
      hotkeys:                    # 桌宠浮窗注册的全局热键（都可以改）
        look: 'F8'                # 看一眼
        ask: 'F7'                 # 看一眼并提问
        collect: 'F9'             # 看几眼
    hotkey:
      enabled: true
      spec: 'option+shift+L'      # 快捷指令模式的热键；格式：修饰键 + 键名
    observe:
      enabled: false              # 旁观：换了应用让桌宠说一句（默认关）
      intervalMs: 5000
      minGapSec: 20
      quietHours: ['23:00-08:00']
    capture:
      maxWidth: 1600              # 截图先缩到这个长边再交给模型
    read:
      maxChars: 12000
    privacy:
      redact: []                  # 读到的文本按这些词脱敏
      pauseOnSensitiveTitles: true
```

配置类型写错不会让插件消失：错误的键会被忽略，并写一条告警。

## 更多文档

- [docs/FEATURES.md](docs/FEATURES.md)：每个功能的入口、行为与边界
- [docs/PRIVACY.md](docs/PRIVACY.md)：读什么、存在哪、怎么删、怎么收回权限
- [CHANGELOG.md](CHANGELOG.md)：版本更新摘要

## 常见问题

| 现象 | 处理 |
|---|---|
| 截图提示没有屏幕录制授权 | 系统设置 → 隐私与安全性 → 屏幕录制 → 勾选 DeepSeek Harness → 重启应用 |
| 窗口列表标题都是空的 | 同上，缺屏幕录制授权 |
| Word 提示自动化授权被拒绝 | 系统设置 → 隐私与安全性 → 自动化 → 允许 DeepSeek Harness 控制 Microsoft Word |
| 桌宠没出现 | 看 `/companion status` 里的 `buddyRunning`；为 false 时重启一次 DSH |
| 热键没反应 | 检查设置页里的热键是否被其他应用占用 |
| 模型说不能看图 | 在设置里换一个支持图片输入的模型 |
| 看一阵按钮没反应 | 先看气泡是否已经出现「开始」；正在收尾时按钮会短暂不响应 |

## 已知限制

- **只读，不代点**：不做鼠标键盘模拟，不点击、不填表。
- **浏览器只能拿到标题**：网页正文需要浏览器扩展桥（尚未实现）。
- **看一阵不是录屏**：按采样间隔取帧，2 秒间隔会漏掉更短的变化；画面完全不动时只保留锚点帧。
- **没有音频**：当前只处理画面与文字，不采集声音。
- **仅 macOS**。

## 开发

需要 Node.js ≥ 18；原生部分需要 Xcode Command Line Tools（仓库已带 universal 二进制，仅改动 Swift 时才需要重编）。

```bash
bash bridge/build.sh          # 原生桥
bash buddy/build.sh           # 桌宠浮窗
npm test                      # 18 套 / 183 项
node test/pack.test.js        # 真的 npm pack 一份，再从带空格的路径试装
node test/identity.test.js    # 包名 / patch id / 客户端 id / 路由一致性
```

目录：

```
lib/          宿主插件代码（工具、命令、HTTP 路由、看一阵）
lib/client.js 面板与设置页（浏览器侧）
bridge/       Swift 原生桥（窗口、截图、选中文字、OCR、拼图）
buddy/        Swift 桌宠浮窗
assets/       默认立绘与图标
test/         测试
docs/         功能说明与隐私说明
```

本地开发时，安装源填仓库的绝对路径即可，改完重挂插件生效。

线上仓库的维护进度与待办见 [docs/MAINTENANCE.md](docs/MAINTENANCE.md)（只记录「线上同步到哪一版」，功能迭代仍以本地为准）。

## 许可

[MIT](LICENSE)
