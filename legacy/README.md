# legacy/ — 旧实现归档

本目录存放 PG4 Assist 历史演进中被取代的实现，**不再维护**，仅备查。
当前交付物是仓库根目录的 [`pg4-assist.js`](../pg4-assist.js)（v2，单文件、无构建、无依赖）。

| 目录 | 内容 | 被取代原因 |
|---|---|---|
| `extension/` | MV3 浏览器扩展（Chrome / Edge，TypeScript + esbuild，6 个打包入口） | 目标环境**禁止安装浏览器扩展**；且架构重（service worker / content script / MAIN-world bridge / parser worker 四层） |
| `snippet-v1/` | v1 单文件 snippet（`pg4-snippet.js`，自建 Shadow DOM 补全菜单 / 悬停卡 / 诊断层） | 自算坐标、自处理键盘、与 pgAdmin 抢 z-index；v2 改为注册原生 CM6 扩展，弹层 / 键盘 / 主题全部交给 CodeMirror |
| `snippet-v1/test/` | v1 的测试基建：`headless.mjs`（纯 Node 回归，**只加载 v1**）、`smoke.html`（最小 CM6 测试页）、`serve.py`（本地静态服务）、SQL 夹具（pagila / EF Core 全引号 demo 库） | 随 v1 归档；v2 的验证方式见[知识库](../docs/pgAdmin%204%20Web%20技术特征与验证知识库.md) §10 |
| `.trae/`、`.workbuddy/` | 当时的开发规划 / 会话记录 | 历史产物 |

## 如需翻查

- 扩展仍可构建：`cd legacy/extension && npm install && npm run build`（产物 `dist/`，加载方式见其内 `Pre-SPEC.md` / `SPED.md`）。
- v1 回归测试仍可运行：`node legacy/snippet-v1/test/headless.mjs`（在 `legacy/snippet-v1/` 下）。
- 演进脉络与技术决策：`extension/Pre-SPEC.md`、`extension/SPED.md`、`extension/docs/pgadmin-cm6-bridge-integration.md`。
