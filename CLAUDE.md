# CLAUDE.md

本仓库面向 AI agent 的约定入口。正文只有一份，本文件仅做导入：

@AGENTS.md
@docs/agent-memory/README.md

开工前请另外阅读 `docs/agent-memory/decisions.md`、`docs/agent-memory/pitfalls.md`，
以及 `docs/agent-memory/log/` 中最近的 1–2 个文件。

若本次会话得出非显然的新结论（踩坑、被否证的假设、实测数据、用户偏好），
按 `docs/agent-memory/README.md` 的写入规范追加到对应文件，并以 `memory:` 前缀**单独提交**。
