# 线上仓库维护

> 这份文档只记录**线上仓库与本地进度的对齐状态**，以及只有线上才需要做的事。
> 功能设计、实现细节、版本日志仍然在本地维护（`DEVLOG.md`、`docs/devlog-history.md`、`CHANGELOG.md`）。
> 线上与本地进度不要求实时一致；**发版时**才把该同步的内容同步上去。

## 当前状态

| 项 | 线上（GitHub） | 本地 |
|---|---|---|
| 版本 | v0.64.2（最新 Release） | 0.64.2 |
| 提交 | 与本地一致 | 见 `git log -1` |
| 测试 | CI 通过 | 18 套 / 183 项 |
| README | 已按公开项目结构重写 | 同左 |

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
