# PG4 Smart Assist

> pgAdmin4 Query Tool 的浏览器增强层（Chrome / Edge，Manifest V3）。
> 离线 Schema 驱动的上下文 SQL 补全、诊断、片段、历史与危险语句拦截。
> **不修改 pgAdmin4、不连接数据库、不外发任何数据。**

---

## 这是什么

`pgAdmin4` 是 PostgreSQL 官方推荐的 Web 管理工具，但其 Query Tool 的 SQL 智能辅助能力严重滞后于现代 IDE：补全依赖实时查询系统表导致延迟高、上下文感知粒度粗、无 JSONB 键路径补全、无实时语法校验、历史容量受限、危险语句无拦截。

**PG4 Smart Assist** 以「寄生式增强」的方式补齐这些短板：在 pgAdmin4 v8.4+ 的 CodeMirror 6 编辑器之上叠加一层离线智能辅助，**不替换编辑器、不接管执行、不读写凭据**，任意时刻出错都静默降级到原生 pgAdmin4。

完整背景与决策见 [Pre-SPEC.md](./Pre-SPEC.md)，实现层规格见 [SPED.md](./SPED.md)。

## 功能特性

- **离线 Schema 驱动补全**：导入 `pg_dump --schema-only` 输出，本地建索引，键入后 P95 ≤ 50ms 出候选，零网络、零数据库查询。
- **上下文感知**：SELECT 后弹列名、FROM 后弹表名、WHERE/ON 推断别名与外键、支持表别名与 CTE 嵌套。
- **JSONB 键路径补全**：在 DDL 中声明 JSONB 字段结构后，`->` / `->>` 后即可补全内部键。
- **加权排序**：基于本地使用频次、最近使用、主键/外键相关性综合排序，而非固定字母序。
- **实时诊断**：语法与基础类型问题在 Worker 内 300ms debounce 后标记，不阻塞键入。
- **对象悬停文档**：悬停表/列/函数即时显示类型、可空、默认值、外键、注释。
- **智能粘贴**：粘贴字段名到 WHERE/VALUES 自动包裹单引号。
- **DDL 快照管理**：多版本快照、增量对比（含重命名检测）、活跃快照秒级切换。
- **片段库 & 查询历史**：分类片段带占位符、历史持久化检索，容量远超原生 20 条限制。
- **危险语句拦截**：`DROP` / `TRUNCATE` / `DELETE WITHOUT WHERE` 等执行前二次确认。
- **安全边界**：所有写入经 CodeMirror 事务（保留 Undo/Redo）、Shadow DOM 隔离 UI、nonce 认证、静默降级。

## 浏览器与版本矩阵

| 平台 | 支持 | 最低版本 |
|---|:---:|---:|
| pgAdmin4 网页版 | 是 | v8.4（CodeMirror 6） |
| Chrome | 是 | 当前企业受管版本 |
| Microsoft Edge | 是 | 当前企业受管版本（Chromium 内核，复用 Chrome 构建） |
| Firefox | 否 | 后续单独验证 |

## 快速开始

### 构建

```bash
npm install
npm run build      # 产物输出到 dist/
# 或开发期监听
npm run watch
```

构建脚本使用 `esbuild`，分别打包 6 个入口（service worker / content script / main-world bridge / parser worker / options / popup），并复制 `public/` 静态资源到 `dist/`。

`dist/` 目录已纳入版本管理，方便直接以「已解压扩展程序」方式加载，无需本地构建。

### 加载扩展

1. 打开 Chrome / Edge，访问 `chrome://extensions`。
2. 开启右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本仓库的 `dist/` 目录。

### 默认注入范围

`manifest.json` 默认只在以下 host 自动注入 content script 与 main-world bridge：

- `http://localhost/*`
- `https://localhost/*`
- `http://127.0.0.1/*`
- `https://127.0.0.1/*`

如需对企业线上 pgAdmin4 启用，在扩展详情页通过「可选权限」授予对应 Host（`optional_host_permissions` 已声明 `https://*/*` 与 `http://*/*`）。

### 导入 Schema 快照

1. 在 PostgreSQL 数据库执行 `pg_dump --schema-only` 生成 DDL 文件。
2. 打开扩展选项页（扩展弹窗 → 设置，或 `chrome://extensions` → PG4 Smart Assist → 详细信息 → 扩展程序选项）。
3. 在「快照」区域上传 DDL 文件，命名并保存。
4. 将该快照与目标 pgAdmin4 站点 origin 绑定（Host Bindings）。
5. 刷新 pgAdmin4 Query Tool 页面，开始键入即触发补全。

可选：在 DDL 中为 JSONB 列追加字段结构声明以启用键路径补全，语法见 [SPED.md](./SPED.md) §5「JSONB 注解」。

## 架构概览

```
pgAdmin4 Query Tool / CodeMirror 6
        ▲   只读事件 + 受控写入(nonce 认证)
        │
┌───────┴────────────────────────────────────────┐
│  MAIN world: main-world-bridge.js              │  发现 CM6 EditorView、转发事件、受控 dispatch
└───────┬────────────────────────────────────────┘
        │  window.postMessage (协议帧 + nonce)
┌───────┴────────────────────────────────────────┐
│  ISOLATED world: content-script.js             │  编排补全/诊断/悬停/危险拦截、Shadow DOM UI
│        │                                       │
│        │  WorkerRpc (typed)                     │
│        ▼                                       │
│  ┌─────────────────────────────┐               │
│  │  parser-worker.js (Worker)  │               │  DDL 解析、补全候选、诊断、危险检测、快照 diff
│  └─────────────────────────────┘               │
└───────┬────────────────────────────────────────┘
        │  chrome.runtime.sendMessage
┌───────┴────────────────────────────────────────┐
│  Service Worker: service-worker.js             │  IndexedDB（快照/历史/使用）、Host 绑定、配置
└────────────────────────────────────────────────┘
```

关键约束（详见 SPED.md §2.1、§4.2）：

- 写入永远走 CodeMirror 事务（`view.dispatch({ changes, userEvent })`），保留 Undo/Redo 与原生事件，**绝不**直接操作 DOM 或 `innerText`。
- 所有页面内容视为不可信，桥接层只转发自身从 CM6 state 计算出的快照，不透传任意页面事件。
- 活跃 Schema、DDL 导入失败、编辑器识别失败或扩展异常时，**静默降级**到原生 pgAdmin4。

## 项目结构

```
.
├── public/                     # 静态资源（manifest、options/popup HTML）
│   └── manifest.json
├── src/
│   ├── background/             # Service Worker（IndexedDB、快照生命周期、Host 绑定）
│   ├── bridge/                 # MAIN-world 桥接（CM6 编辑器发现与受控写入）
│   ├── content/                # 内容脚本（编排、Shadow DOM UI：菜单/诊断/悬停/危险对话框）
│   ├── lib/                    # 核心库（DDL 解析、SQL 词法、上下文解析、补全引擎、诊断、危险检测、快照 diff）
│   ├── options/                # 选项页
│   ├── popup/                  # 弹出页
│   ├── runtime/                # Worker RPC 类型化封装
│   ├── storage/                # IndexedDB + chrome.storage.local
│   ├── types/                  # 跨层类型定义
│   └── worker/                 # parser-worker 入口
├── dist/                       # 构建产物（可直接加载）
├── esbuild.config.mjs          # 打包配置
├── tsconfig.json               # TypeScript 严格模式
├── Pre-SPEC.md                 # 前情提要（已确认事实与决策）
└── SPED.md                     # 开发实施规格
```

## 开发命令

```bash
npm run build        # 生产构建到 dist/
npm run watch        # 监听重建
npm run typecheck    # tsc --noEmit 严格类型检查
npm run clean        # 清理 dist/
```

## 数据与隐私

| 数据类别 | 存储位置 | 是否离开浏览器 |
|---|---|:---:|
| DDL 原文与解析后 Schema | 本机 IndexedDB | 否 |
| 查询历史、候选使用频次、最近使用 | 本机 IndexedDB | 否 |
| 片段、插件设置、活跃环境引用 | `chrome.storage.local` / IndexedDB | 否 |
| 当前页面 SQL / 光标信息 | 内存 | 否 |
| pgAdmin4 Cookie、登录 Token、数据库密码 | **不读取、不持久化** | 否 |

扩展不申请 `<all_urls>`、`cookies`、`webRequest`、`management`、`history` 等不必要权限。安装时由用户显式授权允许注入的 pgAdmin4 Host。

## 测试

线上 pgAdmin4 公共测试环境暂不可用，端到端测试预留后续阶段。`npm run typecheck` 与 `npm run build` 均通过；parser worker 已通过模拟消息的解析/补全/诊断/危险检测冒烟测试。

## 许可证

本项目仅供内部使用。
