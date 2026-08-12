# PG4 Smart Assist Snippet

DevTools Snippet 形态的 PG4 Smart Assist —— pgAdmin4 Query Tool（CodeMirror 6）增强层。

## 为什么有这个项目

公司域控禁止安装浏览器扩展（MV3 `dist/` 无法分发），将核心增强能力移植为 DevTools Snippet：用户在 pgAdmin4 页面 DevTools → Sources → Snippets 中手动运行一次 `pg4-snippet.js`，即可获得：

- 离线 Schema 驱动补全
- 实时诊断
- 对象悬停文档
- 智能粘贴
- 危险语句拦截

绕过扩展安装限制。

## 运行方式

1. 打开 `pg4-snippet.js`，复制全部内容
2. 打开 pgAdmin4 页面 → F12 → Sources → Snippets → New snippet
3. 粘贴代码 → Ctrl+Enter 运行
4. 页面右下角出现齿轮按钮即表示已启动

刷新页面后需重新运行一次 snippet（除非用 Local Overrides 自动注入，见 `CONFIG.runMode`）。

## 项目结构

```
pg4-smart-assist-snippet/
├── pg4-snippet.js     # 单文件交付物（用户粘贴此文件到 DevTools）
├── smoke.html         # 本地验证用 CM6 playground
└── README.md
```

## 与现有 MV3 扩展的关系

完全独立。算法参考 `../src/`（TS 实现），但本项目用纯原生 JS（ES2024+）重写，无构建步骤、无 npm 依赖。

## 规格

权威依据：`../.trae/specs/pg4-snippet-mvp/spec.md` + `checklist.md` + `tasks.md`。
