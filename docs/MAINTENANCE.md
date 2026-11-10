# 线上仓库维护

> 这份文档只记录**线上仓库与本地进度的对齐状态**，以及只有线上才需要做的事。
> 功能设计、实现细节与过程记录仍在本地维护（这些文件不进仓库，见下一节）；`CHANGELOG.md` 是对外的版本摘要。
> 线上与本地进度不要求实时一致；**发版时**才把该同步的内容同步上去。

## 当前状态

| 项 | 线上（GitHub） | 本地 |
|---|---|---|
| 版本 | v1.0.23（最新 Release） | 1.0.23 |
| 提交 | 与本地一致 | 见 `git log -1` |
| 测试 | CI 通过 | 18 套 / 183 项 |
| README | 已按公开项目结构重写 | 同左 |

## 仓库边界（哪些进 GitHub、哪些只在本机）

原则：**GitHub 上只放「别人要用的东西」**；过程记录留在本机，不发布、不进仓库。

| 类别 | 内容 | 是否进仓库 |
|---|---|---|
| 源码 | `lib/`、`bridge/`、`buddy/`、`test/`、`.github/` | ✅ |
| 面向用户的文档 | README、CHANGELOG、docs/FEATURES、docs/PRIVACY、本文档、LICENSE | ✅ |
| 发布资源 | `assets/`（立绘、图标）、`locale/`、`cordis.patch.yml`、`market/` | ✅ |
| 过程记录 | DEVLOG、ROADMAP、docs/devlog-history、docs/EXTERNAL-REFERENCES、docs/AUDIO-DESIGN、docs/audio-and-speech-ideas、docs/watch-experiment、docs/watch-probe-sample、docs/images | ❌ 只在本机（已在 `.gitignore`） |
| 构建产物 | `dist/`（.tgz）、`node_modules/`、`.build/`、日志 | ❌ |

理由：过程记录里有大量实验数据、外部项目调研和未定决策，对使用者没有价值，也不适合长期对外；
它们的变化频率远高于代码，混在仓库里只会让「改了什么」变模糊。

**发布包的边界**由 `package.json` 的 `files` 白名单决定（17 条）：只含运行时必需文件 + 三份用户文档
（README / FEATURES / PRIVACY / MAINTENANCE），不含测试、CI 与任何过程记录。

新增文件时按这张表判断放哪：拿不准就问一句「用户需不需要看到它」。

## 分支与提交

- **单线 `main`**，不长期开分支：功能改动直接在本地改、跑测试、提交、推送；
- 每次提交只做一件事，消息用 `feat:` / `fix:` / `docs:` / `test:` / `chore:` 前缀；
- **发版用 tag**（`vX.Y.Z`）：tag 指向的提交必须已经推送、工作区干净、测试全绿；
- 已发布的 tag 不回改；发现问题就发下一个版本。

## 待办（线上）

- [ ] **README 截图**：截 2–3 张真实界面（桌宠气泡、陪伴记录、看一阵气泡），放到 `assets/screenshots/`，
      在 README「功能」一节后插入。
- [ ] **仓库 About**：一句话描述 + topics（`dsh-plugin`、`macos`、`desktop-pet`、`dsh`、`screen-capture`）。
- [ ] **市场条目**：`awesome-dsh-plugin` PR 状态（仓库需满 1 天、加 `dsh-plugin` topic）；
      模板在 `market/awesome-dsh-plugin.yml`。
- [ ] **市场截图**：`screenshots.json` 与截图资源（没有就回退到 README）。
- [ ] **npm（可选）**：`dsh-companion-journal` 名字目前可用，想发时直接 `npm publish`，不需要改 id。

## 发版清单

功能开发与验证都在本地完成；满足以下全部条件才同步线上：

1. `npm test` 全绿，`node test/pack.test.js` 通过；
2. `package.json` 版本与 `dsh.clientVersion` 已更新，`CHANGELOG.md` 有对应条目；
3. 提交并推送 `main`；
4. 打 tag（`vX.Y.Z`）并推送 → `release.yml` 自动生成发布包与 `.sha256`；
5. 如果本次改动了面向用户的行为或安装方式，同步更新 README 与本文档的「当前状态」。

## 更新记录

| 日期 | 线上版本 | 说明 |
|---|---|---|
| 2026-11-09 | v0.64.1 | 首次公开：重写 README、权限引导、状态页显示权限 |
| 2026-11-09 | v0.64.2 | 发布包包含文档更新；README 热键改为「自定义热键」 |
| 2026-11-09 | v1.0.0 | 版本对齐到 1.0；仓库/发布包边界清理；功能入口统一为右键菜单 |
| 2026-11-09 | v1.0.1 | 设置页/文档去掉固定键位表述，热键统一为可自定义 |
| 2026-11-09 | v1.0.2 | 最低 DSH 版本放宽到 0.2.1-rc.1 |
| 2026-11-11 | v1.0.23 | 看一阵交互完善（手动记帧、同应用窗口跟随、短气泡、面板修复）、设置页可见性、气泡只显示应用名 |
