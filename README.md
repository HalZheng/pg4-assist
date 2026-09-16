# PG4 Assist — pgAdmin 4 Query Tool 离线增强层

单文件、无构建、无依赖。适用于**禁止安装浏览器扩展**的公司环境。

- 交付物：[`pg4-assist.js`](pg4-assist.js)（v2.1，3246 行）
- 页面技术特征与验证知识库：[`docs/pgAdmin 4 Web 技术特征与验证知识库.md`](docs/pgAdmin%204%20Web%20技术特征与验证知识库.md)（改代码前必读）
- 旧版实现（v1 snippet、MV3 浏览器扩展）已归档至 [`legacy/`](legacy/)

## 与旧版的根本差异

旧版（v1 snippet 与浏览器扩展）自己实现补全菜单、悬停卡、诊断层，需要自己算坐标、处理键盘、跟 pgAdmin 抢 z-index。

v2 从 webpack 运行时取出 **pgAdmin 自己那份 CodeMirror 6 模块实例**，直接注册原生 CM6 扩展
（`autocompletion` / `hoverTooltip` / `Decoration` / `domEventHandlers`）。
补全弹层、键盘导航、模糊匹配高亮、定位、主题全部由 CM6 负责。

## 用法

### 方式一：DevTools Snippet（推荐）

1. 打开 pgAdmin 页面（**顶层页面即可，不用切到 iframe 上下文**）
2. F12 → Sources → Snippets → New snippet
3. 粘贴 `pg4-assist.js` 全部内容 → Ctrl+Enter
4. 右下角出现蓝色 `PG` 圆钮即已启动

刷新页面后需重新运行。重复运行是幂等的（会提示「已在运行，跳过」）。

### 方式二：Tampermonkey / 用户脚本

```
// @match       https://<你的-pgadmin-host>/*
// @run-at      document-idle
// @all-frames  true
```

脚本自带 frame 协调逻辑：顶层实例负责注入所有同源 iframe，子 frame 实例会自动退让。

### 方式三：DevTools Local Overrides

把文件挂到 pgAdmin 的某个静态 JS 上自动注入，行为同方式一。

## 首次使用：导入 DDL 快照

点右下角 `PG` → 快照页 → **选择 .sql 文件** → 选 `pg_dump --schema-only` 导出的 DDL。

导入后自动激活并持久化到 IndexedDB，之后每次运行脚本会自动恢复。
（380 KB / 8410 行的 DDL，解析约 120 ms，得到 340 表 / 5224 列 / 102 函数 / 699 索引 / 24 外键。）

## 功能

| 功能 | 说明 |
|---|---|
| **离线补全** | 表 / 视图 / 列 / schema / 函数 / 关键字。输入 1 个字符即自动弹出（pgAdmin 原生要 Ctrl+Space）。候选带类型、PK / NOT NULL / FK、所属表 |
| **智能引号** | 库里是带引号的 PascalCase（EF Core 风格）：输入 `stak` 选中后自动插入 `"StakeholderProfile"`；已打了 `"` 或 `""` 也不会重复 |
| **JOIN 条件推断** | `JOIN x ON` 处直接给出连接条件。显式外键优先，其次按命名约定推断（列 `"StakeholderProfile"` → `"StakeholderProfile"."Id"`） |
| **实时诊断** | 未知表 / 未知列 / **标识符大小写与引号缺失** / UPDATE-DELETE 缺 WHERE / SELECT \*（可选）。波浪下划线 + 悬停看消息 |
| **悬停文档** | 表：类型、schema、列数、主键、外键、索引数、列预览；列：类型、可空、默认值、约束、所在索引、推断关联；函数：参数与返回值 |
| **智能粘贴** | 粘贴文本 / uuid / 日期到 `= ` 后自动加单引号；粘贴多行到 `IN (` 里自动转 `'a', 'b', 'c'`；数字与 SQL 片段原样不动 |
| **查询历史** | 观察 pgAdmin 自己的 `/sqleditor/query_history/` 上报，覆盖所有执行路径，记录 SQL、库名、耗时、影响行数、成败 |
| **使用频次排序** | 采纳过的候选自动加权 |
| **快照对比** | 两个快照间新增 / 删除 / 变更的表与列 |

排序针对本库特点做过调优：公共审计列（`CreatedOn` / `ModifiedBy` / `ScopeId` …）自动降权，
主键、作用域内表、FK 连接条件自动提权。

## 调试

```js
window.__pg4Assist        // Core 实例：sessions / graph / snapshotMeta
window.__pg4              // 调试入口（下列纯函数可脱离编辑器直接跑）
window.__pg4.config       // 当前配置
window.__pg4.attachAll()  // 手动重扫编辑器
window.__pg4.destroy()    // 卸载

// 纯函数，可脱离编辑器直接跑
window.__pg4.analyzeContext(sql, pos, graph)
window.__pg4.buildCandidates(info, graph, new Map())
window.__pg4.runDiagnostics(sql, graph)
window.__pg4.transformPaste(clip, docText, pos)
```

## 站点适配（改代码前必读）

在 pgAdmin 9.10（`app_version_int = 91000`）实测，最关键的四条：

1. Query Tool 位于**同源 iframe** `/sqleditor/panel/<id>`；外层 DIV 与 IFRAME **共用同一个 id**，
   必须用 `querySelectorAll('iframe')`；`cmView` 挂在 **`.cm-content`** 上。
2. 取真 `__webpack_require__` 只能走 `webpackChunk.push` 的**第三个回调参数**——
   自己重放 module factory 会得到 CM6 模块副本，facet 身份不一致，注册的扩展不生效。
3. **不能** `appendConfig(autocompletion({ override: [...] }))`——该版本对 `override` 没有 combiner，
   会抛 `Config merge conflict for field override`；只能就地替换已解析配置里的 `override[0]`。
4. `StateEffect.appendConfig` **不可撤销**——每个 `EditorView` 只挂一次扩展，
   全部通过 `view.__pg4Slot.session` 读取当前会话，脚本重跑不留残余。

完整技术细节、证据与验证方法见
[`docs/pgAdmin 4 Web 技术特征与验证知识库.md`](docs/pgAdmin%204%20Web%20技术特征与验证知识库.md)。

## 仓库结构

```
.
├── pg4-assist.js                                   # 当前交付物（单文件，无构建）
├── docs/
│   ├── pgAdmin 4 Web 技术特征与验证知识库.md        # 页面特征 / 集成边界 / 验证方法
│   └── GitHub Codespaces 部署 PostgreSQL + pgAdmin 4 + Pagila 完整指南.md
│                                                   # 验证环境搭建
└── legacy/                                         # 旧实现归档（见 legacy/README.md）
    ├── extension/                                  # MV3 浏览器扩展（TypeScript + esbuild）
    └── snippet-v1/                                 # v1 自建 UI 版 snippet 及其测试
```

## 未实现 / 后续

- JSONB 路径补全（`->` / `->>` / `#>` 之后的键名）
- 快照按 `database_name` 自动绑定（iframe URL 已带该参数，`detectDatabaseName` 已解析，目前是全局单快照）
