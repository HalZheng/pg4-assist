# 决策与用户偏好

> 只放跨会话仍然成立的结论。`AGENTS.md` 已详述的用一行摘要 + 指路，不复制正文。

## 交付形态

- 交付物是**单文件 `pg4-assist.js`**（IIFE，无构建、无依赖、约 3800 行）。
  注入方式是 DevTools Snippet / 用户脚本 / Local Overrides，不发布浏览器扩展。
- 旧实现（MV3 扩展、v1 snippet）已归档 `legacy/`，**不要在那里加新功能**。
- 运行环境是「禁止安装浏览器扩展」的企业环境，因此任何依赖扩展 API 的方案都不可行。

## 版本号策略（用户偏好，优先级高）

- 对外 `VERSION` **保持克制**：图标、样式、连续小修**不逐次**升版本号。
  仅在明确计划发布或用户明确要求时才改。
- 内部 `GRID_HOOK_REV` 与对外版本解耦，用于替换监听器，可自由递增。
- 改 `DEFAULT_CONFIG` 中默认值的**语义**时必须递增 `CONFIG_VERSION` 并在 `loadConfig()` 加一次性迁移。
  原因：配置合并是 `{...DEFAULT_CONFIG, ...saved}`，老用户 localStorage 里的旧值会盖掉新默认值。

## 性能红线

- 实时诊断默认关闭（`diagnosticsEnabled: false`），理由与实测数据见 `AGENTS.md`。
  不要"顺手"把它改成默认开启。
- `completionSource` 必须用 CM6 的 `doc.sliceString()` 取窗口，
  **禁止**改回 `ctx.state.doc.toString()`（每 90 ms 复制整篇文档）。

## 沟通与提交

- 文档、注释、提交信息统一用**中文**（与既有仓库风格一致）。
- 提交信息使用 `<type>: <版本> — <摘要>` 风格，见 `git log`。

## 环境事实

- 工作区位于 OneDrive 同步目录内；文档中不要记录本机绝对路径。
- 双远端：`github` 指向公开 GitHub 仓库；`origin` 指向公司内网 GitLab（默认推送目标）。
- 本机 git 访问 GitHub 走环境变量代理（`$https_proxy`，端口会变），不是 git 配置。

## 记忆协议本身

- 项目记忆的唯一事实来源是 `docs/agent-memory/`，见其 `README.md`。
- 任何平台的私有记忆目录都只是缓存，结论要回写仓库才算数。
