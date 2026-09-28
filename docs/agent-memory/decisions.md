# 决策与用户偏好

> 只放跨会话仍然成立的结论。`AGENTS.md` 已详述的用一行摘要 + 指路，不复制正文。

## 交付形态

- 交付物是**单文件 `pg4-assist.js`**（IIFE，无构建、无依赖，4000 余行）。
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

## 结果网格增强的入口约定（2026-09-26 用户决定）

- 复制格式选择的**唯一入口是结果单元格右键菜单**。
  **不要**再改写工具栏的「复制 / 复制选项」按钮：不改色、不改 title/aria-label、不拦截它们的点击。
  理由：那是 pgAdmin 原版 UI，接管它会让工具栏变样且需要一套还原逻辑；右键菜单信息量已足够。
- 保留在网格侧的只有：webpack CsvHelper 去引号补丁、Ctrl+C 快捷键补丁、右键菜单。

## 列候选作用域与导出格式（2026-09-28 用户决定）

- 列补全候选**严格限定为当前语句涉及的表**：`buildCandidates` 删除了 `!scopeList.length`
  时的「全库列名」兜底。语句没写 FROM、或引用的表/CTE 不在快照里时，宁可不给列，
  也不把同窗口其他语句与无关表的列混进来；显式 qualifier（`t.`）的全库猜保留。
  为此 `collectScope` 新增 `stmtRefs`（语句内表名引用，无论解析成败，含 CTE 名）。
- 导出格式（CSV / JSON / Markdown）入口在结果单元格**右键菜单「导出格式」组**
  （延续「唯一入口是右键菜单」约定）；格式化为自包含纯文本拼装，**不依赖 pgAdmin CsvHelper**
  （CsvHelper 定位失败时导出仍可用）。CSV 对标 DBeaver/DataGrip：含表头、逗号分隔、
  RFC 4180 转义、CRLF 行尾。`GRID_HOOK_REV` 随之 11→12。
- 本机无 pgAdmin，未真实冒烟；情景提示词见
  `docs/冒烟测试提示词-v2.4.0-导出格式与语句级列作用域.md`。

## 沟通与提交

- 文档、注释、提交信息统一用**中文**（与既有仓库风格一致）。
- 提交信息使用 `<type>: <版本> — <摘要>` 风格，见 `git log`。

## 环境事实

- 工作区位于 OneDrive 同步目录内；文档中不要记录本机绝对路径。
- 双远端：`github` 指向公开 GitHub 仓库；`origin` 指向公司内网 GitLab（默认推送目标）。
  - **适用范围（2026-09-26 用户确认）**：这是**项目级事实**，但**按机器而异**——部分机器（含当前这台）
    只配了 GitHub 单远端（`origin → https://gh-proxy.com/https://github.com/HalZheng/pg4-assist.git`，
    即 GitHub 的镜像代理，无 GitLab）。**不要**据此判定本条记忆有误，也**不要用单机反推全局**；
    动手推送前先 `git remote -v` 看当台机器的实际拓扑。
    - 2026-09-28 更新（本机）：本机已新增 `github → 真实 GitHub` 远端，推送改走 `github`；
      `origin`（gh-proxy）保留作匿名 fetch。细节与证据见 `pitfalls.md`「推送通道」。
- 本机 git 访问 GitHub 走环境变量代理（`$https_proxy`，端口会变），不是 git 配置。

## 记忆协议本身

- 项目记忆的唯一事实来源是 `docs/agent-memory/`，见其 `README.md`。
- 任何平台的私有记忆目录都只是缓存，结论要回写仓库才算数。
