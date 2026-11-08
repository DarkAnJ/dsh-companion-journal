# 隐私说明

dsh-companion-journal 是一个**本地优先**的插件：它读当前窗口、截图、把内容交给你在 DSH 里配置的模型，
并把「看一眼」的结果留在本机。它没有自己的服务器，也不收集遥测。

## 它会读到什么

只有在你或模型明确触发时才会读：

| 数据 | 触发方式 | 去向 |
|---|---|---|
| 前台应用名、窗口标题 | `companion_windows`、旁观、热键 | 只在本机参与判断；`companion_windows` 的结果会返回给当前会话的模型 |
| 窗口截图 | `companion_capture`、热键、右键「看一眼」、看一阵 | 压缩后交给当前会话的模型；需要留存时写入本机历史 |
| 选中的文字 | 按热键时优先读取 | 交给当前会话的模型；写入本机历史 |
| Word / Preview / Skim 正文 | `companion_read` | 同上 |
| Zotero 条目 | `companion_read` | 通过 `127.0.0.1` 的 Zotero 本地 API 读取，不出本机 |

旁观模式只读「前台应用 + 窗口标题 + 空闲秒数」，**不截图、不调用模型**；
它说的固定短句里不含应用名或文档名。

## 它不会做什么

- 不做鼠标/键盘模拟，不点按钮、不填表；
- 不上传任何数据到本插件作者的服务器（作者没有服务器）；
- 不接入分析、埋点、崩溃上报；
- 不读浏览器正文（当前版本只给标题；正文需要浏览器扩展桥，尚未实现）。

## 数据存在哪

默认都在 `~/.dsh/dsh-companion-journal/`：

- `history.jsonl`：陪伴记录（文本、评语、图片路径、时间）；
- `images/`、`sheets/`：截图与拼图；
- `persona.md`、`prompt.json`、`settings.json`：人设、提示词、设置；
- `buddy.state.json`、`hotkey.events` 等运行时文件。

默认保留 **90 天**（配置 `history.retentionDays`），图片按 `history.keepImages` 决定存不存。
删除整个目录即可清除全部本地数据；卸载插件不会自动删除它。

## 脱敏

配置 `privacy.redact` 里的词会在写入历史、交给模型前被替换；`privacy.pauseOnSensitiveTitles`
会在窗口标题命中敏感词时暂停采样。默认黑名单包含密码管理器、邮件、钱包与银行类应用。

## 权限怎么收回

`系统设置 → 隐私与安全性 → 屏幕录制 / 辅助功能 / 自动化`，取消勾选 **DeepSeek Harness**，
然后重启应用。插件在缺权限时会明确提示，不会静默失败。

## 联系

问题与隐私相关反馈请开 GitHub Issue：
<https://github.com/DarkAnJ/dsh-companion-journal/issues>
