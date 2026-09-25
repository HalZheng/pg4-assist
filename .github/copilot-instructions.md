# Copilot 指令 — pg4-assist

- 总纲：`AGENTS.md`（架构、性能与默认值约束、关键坑、调试速查）。动手前必读。
- 项目记忆（跨 agent 唯一事实来源）：`docs/agent-memory/`
  - 开工前读 `decisions.md`、`pitfalls.md` 与 `log/` 中最近的文件。
  - `pitfalls.md` 里的「不要做什么」是硬约束，不要凭直觉推翻。
- 会话结束时若有非显然的新结论：
  1. 按 `docs/agent-memory/README.md` 的写入规范追加到对应文件，以 `memory:` 前缀单独提交；
  2. 同时把要点写入 Copilot 本地记忆（`/memories/repo/`）—— 那是本地缓存，仓库文件才是权威。
- 不要只写本地记忆：Copilot 的记忆目录在工作区之外，其他 agent 看不到。
