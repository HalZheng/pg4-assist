# 项目记忆（跨 agent 唯一事实来源 / SSOT）

本目录是 pg4-assist 的**跨 agent 项目记忆**：仓库内、可版本控制、格式中立（纯 Markdown）。
目标是让 GitHub Copilot / Claude Code / Cursor / Trae / WorkBuddy / Codex 等工具的会话记忆不再是孤岛。

## 为什么需要它

各平台的记忆/指令默认散落在互不可见的位置：

| 平台 | 默认位置 | 能否被 git 追踪 |
| --- | --- | --- |
| VS Code Copilot Chat | `%APPDATA%\Code\User\workspaceStorage\<hash>\GitHub.copilot-chat\memory-tool\memories\repo\` | ❌ 在工作区外，且 `<hash>` 随工作区路径变化 |
| Claude Code | `CLAUDE.md`（项目级）/ `~/.claude/CLAUDE.md`（用户级） | ✅ 项目级可以 |
| Cursor | `.cursor/rules/*.mdc`（旧版 `.cursorrules`） | ✅ |
| Trae | `.trae/rules/`、`.trae/specs/` | ✅ |
| WorkBuddy | `.workbuddy/memory/` | ✅ |
| Codex / 多数新工具 | `AGENTS.md` | ✅ |

两条硬结论：

1. **不要把任何单一平台的记忆目录当共享区。** 各平台目录里只放一行指针，正文只有本目录这一份。
2. Copilot 的 `/memories/repo/` 定位为**本地热缓存**：写在那里的结论只要对项目有长期价值，
   就必须回写到这里；只写本地 = 其他 agent 永远看不到。

## 目录约定

- `decisions.md` —— 长期稳定的决策与用户偏好。少而精，改动前想清楚。
- `pitfalls.md` —— 环境 / 工具 / API 的坑，以及「不要做什么」。
- `log/YYYY-MM-DD.md` —— 按日期的会话流水。**只追加，不改写历史。**

`AGENTS.md` 仍是面向人的总纲（架构、性能约束、调试速查）。
本目录是它的**增量补充**，不要复制粘贴两份——重复的内容一定会漂移。

## 写入规范

每条记忆尽量写全四要素：**结论 / 证据 / 适用范围 / 失效条件**。

- 用一句「结论句」开头，能一行说清就别写一段。
- 附验证方式或原始数据（文件路径、命令、数字），让下一个人可复现。
- 明确写**反例**。例如「WeChat IME 问题未修复，不要声称已修复」——这句话存在的意义就是
  阻止别的 agent 凭直觉"顺手修好"。
- 带日期/版本号，方便判断是否过期。
- **只追加**：修正旧条目用「更正：」标注，不静默改写（其他 agent 可能已基于旧结论干过活）。

## 各平台接入（都只是指针）

- `AGENTS.md` §项目记忆 —— 通用入口，多数平台会原生读取
- `CLAUDE.md` —— Claude Code（`@` 导入语法）
- `.github/copilot-instructions.md` —— VS Code Copilot
- `.cursor/rules/agent-memory.mdc` —— Cursor（`alwaysApply`）
- `.trae/rules/project_rules.md` —— Trae
- `.workbuddy/memory/README.md` —— WorkBuddy

> 若某个平台的规则路径与上表不符（各版本差异较大），把对应 stub 复制到它真正读取的路径即可，
> 内容不用改——stub 只有指针，没有正文。

## 给其他 agent 的开场提示词

切到别的平台时，把这段作为第一条消息发出（或写进该平台的全局提示词）：

> 先读 `AGENTS.md` 和 `docs/agent-memory/`（`decisions.md`、`pitfalls.md`、`log/` 里最近 1–2 个文件），
> 再开始动手。本次会话若得到非显然的新结论，结束时按 `docs/agent-memory/README.md` 的写入规范
> 追加到对应文件，并**单独提交**，提交信息以 `memory:` 开头。

## 提交约定

记忆变更单独成一个 commit，信息以 `memory:` 开头，例如：

```
memory: 记录 v2.2.7 未提交的工作树状态与 wechat IME 未修复结论
```

这样 `git log --grep '^memory:'` 就能审计所有记忆变更，也不会和代码改动混在一个 diff 里。
