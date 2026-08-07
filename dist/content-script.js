"use strict";
(() => {
  // src/types/messages.ts
  var BRIDGE_PROTOCOL_VERSION = 1;
  var CONTENT_SOURCE = "pg4-content";
  function isBridgeMessage(v) {
    if (!v || typeof v !== "object") return false;
    const m = v;
    return m.version === BRIDGE_PROTOCOL_VERSION && typeof m.requestId === "string" && typeof m.type === "string" && typeof m.source === "string";
  }
  function newRequestId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  function newNonce() {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // src/runtime/worker-rpc.ts
  var WorkerRpcClient = class {
    constructor(worker) {
      this.worker = worker;
      worker.addEventListener("message", this.onMessage);
      worker.addEventListener("error", (e) => {
        for (const [, p] of this.pending) p.reject(new Error(e.message || "worker error"));
      });
    }
    pending = /* @__PURE__ */ new Map();
    progressListener = null;
    seq = 0;
    onMessage = (ev) => {
      const data = ev.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "progress" && typeof data.id === "string") {
        this.progressListener?.(data.progress);
        return;
      }
      if (typeof data.id !== "string") return;
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      if (data.ok === true) p.resolve(data.result);
      else p.reject(new Error(data.error?.message || "worker error"));
    };
    onProgress(cb) {
      this.progressListener = cb;
    }
    call(type, payload) {
      const id = `${type}-${this.seq++}-${Math.random().toString(36).slice(2, 6)}`;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        const req = { id, type, ...payload };
        this.worker.postMessage(req);
      });
    }
    terminate() {
      this.worker.removeEventListener("message", this.onMessage);
      this.worker.terminate();
      for (const [, p] of this.pending) p.reject(new Error("terminated"));
      this.pending.clear();
    }
  };

  // src/content/overlay-host.ts
  var THEME_ATTR = "data-pg4-theme";
  var hostEl = null;
  var shadowRoot = null;
  var currentTheme = "light";
  var themeListeners = /* @__PURE__ */ new Set();
  var themeObserver = null;
  var mediaQuery = null;
  function ensureOverlayHost() {
    if (hostEl && shadowRoot && hostEl.isConnected) {
      return { host: hostEl, shadow: shadowRoot };
    }
    hostEl = document.createElement("div");
    hostEl.id = "pg4-overlay-root";
    hostEl.style.all = "initial";
    hostEl.style.position = "fixed";
    hostEl.style.top = "0";
    hostEl.style.left = "0";
    hostEl.style.width = "0";
    hostEl.style.height = "0";
    hostEl.style.zIndex = "2147483600";
    hostEl.style.pointerEvents = "none";
    document.documentElement.appendChild(hostEl);
    shadowRoot = hostEl.attachShadow({ mode: "open" });
    injectBaseStyles(shadowRoot);
    currentTheme = detectTheme();
    shadowRoot.host.setAttribute(THEME_ATTR, currentTheme);
    startThemeWatching();
    return { host: hostEl, shadow: shadowRoot };
  }
  function getShadow() {
    if (!shadowRoot) {
      ensureOverlayHost();
    }
    return shadowRoot;
  }
  function getTheme() {
    return currentTheme;
  }
  function onThemeChange(cb) {
    themeListeners.add(cb);
    return () => {
      themeListeners.delete(cb);
    };
  }
  function setTheme(mode) {
    if (mode === currentTheme) return;
    currentTheme = mode;
    shadowRoot?.host.setAttribute(THEME_ATTR, mode);
    for (const cb of themeListeners) {
      try {
        cb(mode);
      } catch {
      }
    }
  }
  function detectTheme() {
    const candidates = [
      document.documentElement,
      document.body,
      document.querySelector(".pgadmin-container"),
      document.querySelector("#pgcontainer")
    ].filter(Boolean);
    for (const el of candidates) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg) {
        const lum = parseLuminance(bg);
        if (lum !== null) {
          return lum < 0.4 ? "dark" : "light";
        }
      }
      if (el.getAttribute("data-theme")?.includes("dark")) return "dark";
      if (el.getAttribute("data-theme")?.includes("light")) return "light";
      if (el.classList.contains("dark") || el.classList.contains("theme-dark")) return "dark";
      if (el.classList.contains("light") || el.classList.contains("theme-light")) return "light";
    }
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    return mq?.matches ? "dark" : "light";
  }
  function parseLuminance(bg) {
    const m = bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
    if (parts.length < 3) return null;
    const [r, g, b] = parts;
    return 0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255);
  }
  function startThemeWatching() {
    themeObserver = new MutationObserver(() => {
      setTheme(detectTheme());
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", THEME_ATTR],
      subtree: false
    });
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
      subtree: false
    });
    mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
    mediaQuery?.addEventListener?.("change", () => setTheme(detectTheme()));
  }
  function injectBaseStyles(shadow) {
    const style = document.createElement("style");
    style.textContent = `
    :host, :host * { box-sizing: border-box; }
    :host {
      --pg4-bg: #ffffff;
      --pg4-fg: #1f2328;
      --pg4-muted: #57606a;
      --pg4-border: #d0d7de;
      --pg4-accent: #0969da;
      --pg4-accent-fg: #ffffff;
      --pg4-error: #cf222e;
      --pg4-error-bg: #ffebe9;
      --pg4-warn: #bf8700;
      --pg4-warn-bg: #fff8c5;
      --pg4-row-hover: #f6f8fa;
      --pg4-row-selected: #ddf4ff;
      --pg4-shadow: 0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.08);
      --pg4-radius: 6px;
      --pg4-font: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
      --pg4-mono: "SFMono-Regular", "JetBrains Mono", "Menlo", "Consolas", monospace;
      font-family: var(--pg4-font);
      color: var(--pg4-fg);
    }
    :host([${THEME_ATTR}="dark"]) {
      --pg4-bg: #1c2128;
      --pg4-fg: #e6edf3;
      --pg4-muted: #8b949e;
      --pg4-border: #30363d;
      --pg4-accent: #58a6ff;
      --pg4-accent-fg: #0d1117;
      --pg4-error: #f85149;
      --pg4-error-bg: #4a1e1e;
      --pg4-warn: #d29922;
      --pg4-warn-bg: #3a2e0a;
      --pg4-row-hover: #21262d;
      --pg4-row-selected: #1f6feb33;
      --pg4-shadow: 0 8px 24px rgba(0,0,0,0.5), 0 2px 6px rgba(0,0,0,0.4);
    }
  `;
    shadow.appendChild(style);
  }

  // src/content/completion-menu.ts
  var CompletionMenu = class {
    container;
    listbox;
    items;
    selected = 0;
    replaceRange;
    onSelect;
    onCancel;
    onHighlight;
    destroyed = false;
    keydownHandler;
    outsideClickHandler;
    blurHandler;
    resizeHandler;
    constructor(opts) {
      const shadow = getShadow();
      this.items = opts.items;
      this.replaceRange = opts.replaceRange;
      this.onSelect = opts.onSelect;
      this.onCancel = opts.onCancel;
      this.onHighlight = opts.onHighlight;
      this.selected = Math.min(Math.max(opts.initialIndex ?? 0, 0), Math.max(0, this.items.length - 1));
      this.container = document.createElement("div");
      this.container.className = "pg4-completion-menu";
      this.container.setAttribute("role", "listbox");
      this.container.setAttribute("aria-label", "PG4 SQL completion");
      this.container.tabIndex = -1;
      this.container.style.position = "fixed";
      this.container.style.zIndex = "2147483647";
      this.container.style.pointerEvents = "auto";
      this.listbox = document.createElement("ul");
      this.listbox.className = "pg4-completion-list";
      this.container.appendChild(this.listbox);
      this.renderItems();
      this.applyTheme();
      this.position(opts.anchor);
      shadow.appendChild(this.container);
      this.keydownHandler = (ev) => this.onKeyDown(ev);
      this.outsideClickHandler = (ev) => this.onOutsideClick(ev);
      this.blurHandler = () => this.destroy("blur");
      this.resizeHandler = () => {
        if (this.destroyed) return;
        this.position(opts.anchor);
      };
      document.addEventListener("keydown", this.keydownHandler, true);
      document.addEventListener("mousedown", this.outsideClickHandler, true);
      window.addEventListener("blur", this.blurHandler);
      window.addEventListener("resize", this.resizeHandler);
    }
    applyTheme() {
      const theme = getTheme();
      this.container.setAttribute("data-theme", theme);
    }
    renderItems() {
      this.listbox.innerHTML = "";
      const max = this.items.length;
      const cap = 50;
      const shown = Math.min(max, cap);
      for (let i = 0; i < shown; i++) {
        const item = this.items[i];
        const li = document.createElement("li");
        li.className = "pg4-completion-item";
        li.setAttribute("role", "option");
        li.id = `pg4-cm-item-${i}`;
        li.dataset.index = String(i);
        li.dataset.kind = item.kind;
        const icon = document.createElement("span");
        icon.className = "pg4-icon pg4-icon-" + item.kind;
        icon.textContent = iconFor(item.kind);
        icon.setAttribute("aria-hidden", "true");
        const label = document.createElement("span");
        label.className = "pg4-label";
        label.textContent = item.label;
        const detail = document.createElement("span");
        detail.className = "pg4-detail";
        detail.textContent = item.detail ?? "";
        li.appendChild(icon);
        li.appendChild(label);
        li.appendChild(detail);
        li.addEventListener("mouseenter", () => this.setSelected(
          i,
          /* fromMouse */
          true
        ));
        li.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          this.setSelected(i, true);
          this.commit();
        });
        this.listbox.appendChild(li);
      }
      this.setSelected(this.selected, false);
      if (max > cap) {
        const more = document.createElement("li");
        more.className = "pg4-completion-more";
        more.textContent = `+${max - cap} more (refine filter)`;
        more.setAttribute("aria-hidden", "true");
        this.listbox.appendChild(more);
      }
    }
    setSelected(idx, fromMouse) {
      if (this.destroyed) return;
      const clamped = Math.max(0, Math.min(idx, this.items.length - 1));
      if (clamped === this.selected && !fromMouse) return;
      this.selected = clamped;
      const items = this.listbox.querySelectorAll(".pg4-completion-item");
      items.forEach((el, i) => {
        const li = el;
        const active = i === clamped;
        li.classList.toggle("pg4-active", active);
        li.setAttribute("aria-selected", active ? "true" : "false");
        if (active) {
          li.scrollIntoView({ block: "nearest" });
        }
      });
      this.onHighlight?.(this.items[clamped] ?? null);
    }
    onKeyDown(ev) {
      if (this.destroyed) return;
      switch (ev.key) {
        case "ArrowDown":
          ev.preventDefault();
          ev.stopPropagation();
          this.setSelected(this.selected + 1, false);
          break;
        case "ArrowUp":
          ev.preventDefault();
          ev.stopPropagation();
          this.setSelected(this.selected - 1, false);
          break;
        case "PageDown":
          ev.preventDefault();
          ev.stopPropagation();
          this.setSelected(this.selected + 8, false);
          break;
        case "PageUp":
          ev.preventDefault();
          ev.stopPropagation();
          this.setSelected(this.selected - 8, false);
          break;
        case "Home":
          ev.preventDefault();
          ev.stopPropagation();
          this.setSelected(0, false);
          break;
        case "End":
          ev.preventDefault();
          ev.stopPropagation();
          this.setSelected(this.items.length - 1, false);
          break;
        case "Enter":
        case "Tab":
          ev.preventDefault();
          ev.stopPropagation();
          this.commit();
          break;
        case "Escape":
          ev.preventDefault();
          ev.stopPropagation();
          this.destroy("escape");
          break;
        default:
          break;
      }
    }
    onOutsideClick(ev) {
      if (this.destroyed) return;
      const target = ev.target;
      if (target && this.container.contains(target)) return;
      this.destroy("outside-click");
    }
    commit() {
      if (this.destroyed) return;
      const item = this.items[this.selected];
      if (!item) {
        this.destroy("escape");
        return;
      }
      this.destroyed = true;
      this.cleanup();
      this.onSelect(item, this.replaceRange);
    }
    /** Update items when prefix changes (called by content script). */
    update(items, replaceRange, anchor) {
      this.items = items;
      this.replaceRange = replaceRange;
      this.selected = Math.min(this.selected, Math.max(0, items.length - 1));
      this.renderItems();
      this.position(anchor);
    }
    /** Re-position the menu relative to the current cursor coordinates. */
    position(anchor) {
      const menuW = 360;
      const menuMaxH = 320;
      const viewportH = window.innerHeight;
      const below = anchor.bottom;
      const above = anchor.top;
      const placeBelow = below + menuMaxH <= viewportH || below >= above;
      const top = placeBelow ? below : Math.max(8, anchor.top - menuMaxH);
      let left = anchor.left;
      if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
      if (left < 8) left = 8;
      this.container.style.left = `${left}px`;
      this.container.style.top = `${top}px`;
      this.container.style.width = `${menuW}px`;
      this.container.style.maxHeight = `${menuMaxH}px`;
    }
    destroy(reason) {
      if (this.destroyed) return;
      this.destroyed = true;
      this.cleanup();
      if (reason !== "external") {
        this.onCancel(reason);
      }
    }
    cleanup() {
      document.removeEventListener("keydown", this.keydownHandler, true);
      document.removeEventListener("mousedown", this.outsideClickHandler, true);
      window.removeEventListener("blur", this.blurHandler);
      window.removeEventListener("resize", this.resizeHandler);
      this.container.remove();
    }
    static injectStyles(shadow) {
      const style = document.createElement("style");
      style.textContent = `
      .pg4-completion-menu {
        background: var(--pg4-bg);
        color: var(--pg4-fg);
        border: 1px solid var(--pg4-border);
        border-radius: var(--pg4-radius);
        box-shadow: var(--pg4-shadow);
        font-family: var(--pg4-font);
        font-size: 13px;
        line-height: 1.4;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      .pg4-completion-list {
        list-style: none;
        margin: 0;
        padding: 4px 0;
        max-height: 320px;
        overflow-y: auto;
      }
      .pg4-completion-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 10px;
        cursor: pointer;
        white-space: nowrap;
      }
      .pg4-completion-item.pg4-active {
        background: var(--pg4-row-selected);
        color: var(--pg4-fg);
      }
      .pg4-completion-item .pg4-icon {
        width: 16px;
        text-align: center;
        opacity: 0.85;
        font-size: 12px;
      }
      .pg4-completion-item[data-kind="column"] .pg4-icon { color: #0969da; }
      .pg4-completion-item[data-kind="table"] .pg4-icon,
      .pg4-completion-item[data-kind="view"] .pg4-icon { color: #1a7f37; }
      .pg4-completion-item[data-kind="function"] .pg4-icon { color: #8250df; }
      .pg4-completion-item[data-kind="keyword"] .pg4-icon { color: var(--pg4-muted); }
      .pg4-completion-item[data-kind="jsonb-path"] .pg4-icon { color: #bf8700; }
      .pg4-completion-item[data-kind="snippet"] .pg4-icon { color: #cf222e; }
      .pg4-completion-item .pg4-label {
        flex: 0 0 auto;
        font-family: var(--pg4-mono);
        font-size: 12.5px;
      }
      .pg4-completion-item .pg4-detail {
        flex: 1 1 auto;
        margin-left: auto;
        color: var(--pg4-muted);
        font-size: 11.5px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .pg4-completion-more {
        padding: 6px 10px;
        color: var(--pg4-muted);
        font-size: 11px;
        text-align: center;
        font-style: italic;
      }
      :host([data-pg4-theme="dark"]) .pg4-completion-item[data-kind="column"] .pg4-icon { color: #58a6ff; }
      :host([data-pg4-theme="dark"]) .pg4-completion-item[data-kind="table"] .pg4-icon,
      :host([data-pg4-theme="dark"]) .pg4-completion-item[data-kind="view"] .pg4-icon { color: #3fb950; }
      :host([data-pg4-theme="dark"]) .pg4-completion-item[data-kind="function"] .pg4-icon { color: #bc8cff; }
      :host([data-pg4-theme="dark"]) .pg4-completion-item[data-kind="jsonb-path"] .pg4-icon { color: #d29922; }
    `;
      shadow.appendChild(style);
    }
  };
  function iconFor(kind) {
    switch (kind) {
      case "table":
        return "\u25A6";
      case "view":
        return "\u25F3";
      case "column":
        return "\u2AF6";
      case "function":
        return "\u0192";
      case "keyword":
        return "K";
      case "snippet":
        return "\u276F";
      case "jsonb-path":
        return "{}";
      case "cte":
        return "\u21BB";
      default:
        return "\u2022";
    }
  }

  // src/content/danger-dialog.ts
  var DangerDialog = class {
    container;
    cancelled = false;
    keydownHandler;
    outsideClickHandler;
    constructor(opts) {
      const shadow = document.getElementById("pg4-overlay-root")?.shadowRoot;
      if (!shadow) {
        opts.onCancel();
        this.container = null;
        this.keydownHandler = () => {
        };
        this.outsideClickHandler = () => {
        };
        return;
      }
      this.container = document.createElement("div");
      this.container.className = "pg4-danger-dialog";
      this.container.setAttribute("role", "dialog");
      this.container.setAttribute("aria-modal", "true");
      this.container.setAttribute("aria-labelledby", "pg4-danger-title");
      this.container.style.pointerEvents = "auto";
      const title = document.createElement("div");
      title.id = "pg4-danger-title";
      title.className = "pg4-danger-title";
      title.textContent = `Risk: ${opts.result.kind ?? "Dangerous statement"}`;
      const reasons = document.createElement("ul");
      reasons.className = "pg4-danger-reasons";
      for (const r of opts.result.reasons) {
        const li = document.createElement("li");
        li.textContent = r;
        reasons.appendChild(li);
      }
      const targets = opts.result.targetObjects.length ? (() => {
        const box = document.createElement("div");
        box.className = "pg4-danger-targets";
        const lbl = document.createElement("div");
        lbl.className = "pg4-danger-section-label";
        lbl.textContent = "Target objects";
        const list = document.createElement("div");
        list.className = "pg4-danger-target-list";
        list.textContent = opts.result.targetObjects.join(", ");
        box.appendChild(lbl);
        box.appendChild(list);
        return box;
      })() : null;
      const sqlBox = document.createElement("pre");
      sqlBox.className = "pg4-danger-sql";
      sqlBox.textContent = truncateSql(opts.sql);
      const actions = document.createElement("div");
      actions.className = "pg4-danger-actions";
      const cancel = document.createElement("button");
      cancel.className = "pg4-btn pg4-btn-cancel";
      cancel.textContent = "Cancel (Esc)";
      cancel.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.close("cancel", opts);
      });
      const explain = document.createElement("button");
      explain.className = "pg4-btn pg4-btn-explain";
      explain.textContent = "EXPLAIN estimate";
      explain.title = "Run EXPLAIN <statement> via pgAdmin4's existing query channel";
      explain.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.close("explain", opts);
      });
      const proceed = document.createElement("button");
      proceed.className = "pg4-btn pg4-btn-proceed";
      proceed.textContent = "Proceed anyway";
      proceed.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.close("execute", opts);
      });
      actions.appendChild(cancel);
      actions.appendChild(explain);
      actions.appendChild(proceed);
      this.container.appendChild(title);
      if (reasons.childNodes.length) this.container.appendChild(reasons);
      if (targets) this.container.appendChild(targets);
      this.container.appendChild(sqlBox);
      this.container.appendChild(actions);
      shadow.appendChild(this.container);
      this.keydownHandler = (ev) => {
        if (ev.key === "Escape") {
          ev.preventDefault();
          ev.stopPropagation();
          this.close("cancel", opts);
        } else if (ev.key === "Enter") {
          ev.preventDefault();
          ev.stopPropagation();
          this.close("cancel", opts);
        }
      };
      this.outsideClickHandler = (ev) => {
        const target = ev.target;
        if (target && this.container.contains(target)) return;
        ev.preventDefault();
        ev.stopPropagation();
      };
      document.addEventListener("keydown", this.keydownHandler, true);
      document.addEventListener("mousedown", this.outsideClickHandler, true);
      setTimeout(() => cancel.focus(), 0);
    }
    close(mode, opts) {
      if (this.cancelled) return;
      this.cancelled = true;
      document.removeEventListener("keydown", this.keydownHandler, true);
      document.removeEventListener("mousedown", this.outsideClickHandler, true);
      if (this.container) this.container.remove();
      if (mode === "cancel") opts.onCancel();
      else opts.onConfirm(mode);
    }
    static injectStyles(shadow) {
      const style = document.createElement("style");
      style.textContent = `
      .pg4-danger-dialog {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: var(--pg4-bg);
        color: var(--pg4-fg);
        border: 1px solid var(--pg4-error);
        border-radius: var(--pg4-radius);
        box-shadow: var(--pg4-shadow);
        padding: 16px 18px;
        min-width: 360px;
        max-width: 560px;
        font-family: var(--pg4-font);
        z-index: 2147483647;
      }
      .pg4-danger-title {
        font-size: 15px;
        font-weight: 600;
        color: var(--pg4-error);
        margin-bottom: 8px;
      }
      .pg4-danger-reasons {
        margin: 0 0 10px 18px;
        padding: 0;
        font-size: 12.5px;
        color: var(--pg4-fg);
      }
      .pg4-danger-reasons li { margin: 2px 0; }
      .pg4-danger-section-label {
        font-size: 11px;
        color: var(--pg4-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 2px;
      }
      .pg4-danger-target-list {
        font-family: var(--pg4-mono);
        font-size: 12px;
        color: var(--pg4-fg);
        margin-bottom: 8px;
      }
      .pg4-danger-sql {
        background: var(--pg4-error-bg);
        border: 1px solid var(--pg4-error);
        border-radius: 4px;
        padding: 8px 10px;
        font-family: var(--pg4-mono);
        font-size: 12px;
        white-space: pre-wrap;
        max-height: 200px;
        overflow: auto;
        margin: 0 0 12px 0;
      }
      .pg4-danger-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }
      .pg4-btn {
        padding: 6px 12px;
        border-radius: 4px;
        border: 1px solid var(--pg4-border);
        background: var(--pg4-bg);
        color: var(--pg4-fg);
        font-size: 12.5px;
        cursor: pointer;
      }
      .pg4-btn:hover { background: var(--pg4-row-hover); }
      .pg4-btn-cancel { color: var(--pg4-muted); }
      .pg4-btn-proceed {
        background: var(--pg4-error);
        color: #fff;
        border-color: var(--pg4-error);
      }
      .pg4-btn-proceed:hover { filter: brightness(1.05); background: var(--pg4-error); }
      .pg4-btn-explain {
        color: var(--pg4-accent);
        border-color: var(--pg4-accent);
      }
    `;
      shadow.appendChild(style);
    }
  };
  function truncateSql(sql) {
    const max = 1200;
    if (sql.length <= max) return sql;
    return sql.slice(0, max) + "\n\u2026[truncated]";
  }

  // src/content/hover-card.ts
  var HoverCard = class {
    container;
    hideTimer = null;
    keydownHandler;
    constructor() {
      const shadow = getShadow();
      this.container = document.createElement("div");
      this.container.className = "pg4-hover-card";
      this.container.setAttribute("role", "tooltip");
      this.container.setAttribute("aria-hidden", "true");
      this.container.style.pointerEvents = "none";
      this.container.style.position = "fixed";
      this.container.style.zIndex = "2147483646";
      this.container.style.display = "none";
      shadow.appendChild(this.container);
      this.keydownHandler = (ev) => {
        if (ev.key === "Escape") this.hide();
      };
      document.addEventListener("keydown", this.keydownHandler, true);
    }
    /** Show the card near the given coordinates. */
    show(doc, anchor) {
      this.container.innerHTML = "";
      const header = document.createElement("div");
      header.className = "pg4-hover-header";
      header.textContent = doc.qualifiedName;
      this.container.appendChild(header);
      const kind = document.createElement("div");
      kind.className = "pg4-hover-kind";
      kind.textContent = doc.kind;
      this.container.appendChild(kind);
      if (doc.dataType) {
        const t = document.createElement("div");
        t.className = "pg4-hover-row";
        t.innerHTML = `<span class="pg4-hover-label">Type</span><span class="pg4-hover-value">${escapeHtml(doc.dataType)}</span>`;
        this.container.appendChild(t);
      }
      if (doc.nullable !== void 0) {
        const t = document.createElement("div");
        t.className = "pg4-hover-row";
        t.innerHTML = `<span class="pg4-hover-label">Nullable</span><span class="pg4-hover-value">${doc.nullable ? "YES" : "NO"}</span>`;
        this.container.appendChild(t);
      }
      if (doc.defaultExpression) {
        const t = document.createElement("div");
        t.className = "pg4-hover-row";
        t.innerHTML = `<span class="pg4-hover-label">Default</span><span class="pg4-hover-value">${escapeHtml(doc.defaultExpression)}</span>`;
        this.container.appendChild(t);
      }
      if (doc.primaryKey && doc.primaryKey.length) {
        const t = document.createElement("div");
        t.className = "pg4-hover-row";
        t.innerHTML = `<span class="pg4-hover-label">PK</span><span class="pg4-hover-value">${escapeHtml(doc.primaryKey.join(", "))}</span>`;
        this.container.appendChild(t);
      }
      if (doc.foreignKey) {
        const t = document.createElement("div");
        t.className = "pg4-hover-row";
        t.innerHTML = `<span class="pg4-hover-label">FK</span><span class="pg4-hover-value">${escapeHtml(doc.foreignKey)}</span>`;
        this.container.appendChild(t);
      }
      if (doc.jsonbRootCount !== void 0 && doc.jsonbRootCount > 0) {
        const t = document.createElement("div");
        t.className = "pg4-hover-row";
        t.innerHTML = `<span class="pg4-hover-label">JSONB paths</span><span class="pg4-hover-value">${doc.jsonbRootCount}</span>`;
        this.container.appendChild(t);
      }
      if (doc.comment) {
        const c = document.createElement("div");
        c.className = "pg4-hover-comment";
        c.textContent = doc.comment;
        this.container.appendChild(c);
      }
      this.container.style.display = "block";
      const rect = this.container.getBoundingClientRect();
      const margin = 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = anchor.left;
      let top = anchor.bottom + 4;
      if (left + rect.width > vw - margin) left = vw - rect.width - margin;
      if (left < margin) left = margin;
      if (top + rect.height > vh - margin) {
        top = Math.max(margin, anchor.top - rect.height - 4);
      }
      this.container.style.left = `${left}px`;
      this.container.style.top = `${top}px`;
      this.container.setAttribute("aria-hidden", "false");
      if (this.hideTimer !== null) {
        clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }
    }
    scheduleHide(delayMs = 150) {
      if (this.hideTimer !== null) clearTimeout(this.hideTimer);
      this.hideTimer = window.setTimeout(() => this.hide(), delayMs);
    }
    cancelHide() {
      if (this.hideTimer !== null) {
        clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }
    }
    hide() {
      this.container.style.display = "none";
      this.container.setAttribute("aria-hidden", "true");
    }
    destroy() {
      document.removeEventListener("keydown", this.keydownHandler, true);
      this.container.remove();
    }
    static injectStyles(shadow) {
      const style = document.createElement("style");
      style.textContent = `
      .pg4-hover-card {
        background: var(--pg4-bg);
        color: var(--pg4-fg);
        border: 1px solid var(--pg4-border);
        border-radius: var(--pg4-radius);
        box-shadow: var(--pg4-shadow);
        padding: 10px 12px;
        font-family: var(--pg4-font);
        font-size: 12.5px;
        min-width: 200px;
        max-width: 460px;
        pointer-events: auto;
      }
      .pg4-hover-header {
        font-weight: 600;
        font-family: var(--pg4-mono);
        margin-bottom: 4px;
        color: var(--pg4-fg);
      }
      .pg4-hover-kind {
        font-size: 11px;
        color: var(--pg4-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 6px;
      }
      .pg4-hover-row {
        display: flex;
        gap: 8px;
        margin: 2px 0;
      }
      .pg4-hover-label {
        color: var(--pg4-muted);
        min-width: 64px;
        font-size: 11.5px;
      }
      .pg4-hover-value {
        font-family: var(--pg4-mono);
        color: var(--pg4-fg);
        word-break: break-word;
      }
      .pg4-hover-comment {
        margin-top: 6px;
        padding-top: 6px;
        border-top: 1px dashed var(--pg4-border);
        color: var(--pg4-muted);
        font-style: italic;
        white-space: pre-wrap;
      }
    `;
      shadow.appendChild(style);
    }
  };
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // src/content/diagnostics-overlay.ts
  var DiagnosticsOverlay = class {
    container;
    editorDom;
    diagnostics = [];
    constructor(editorDom) {
      const shadow = getShadow();
      this.container = document.createElement("div");
      this.container.className = "pg4-diagnostics-overlay";
      this.container.style.display = "none";
      this.editorDom = editorDom;
      shadow.appendChild(this.container);
    }
    /** Update the diagnostics display. coordsOf is a way to compute (left,top,right,bottom) for
     *  a given document offset, provided by the bridge. */
    async update(diagnostics, coordsOf) {
      this.diagnostics = diagnostics;
      this.container.innerHTML = "";
      if (!diagnostics.length) {
        this.container.style.display = "none";
        return;
      }
      const editorRect = this.editorDom?.getBoundingClientRect();
      let drawn = 0;
      for (const d of diagnostics) {
        const rect = coordsOf(d.from);
        if (!rect) continue;
        const marker = document.createElement("div");
        marker.className = `pg4-diag pg4-diag-${d.severity}`;
        marker.setAttribute("role", "tooltip");
        marker.title = `${d.message} [${d.code}]`;
        const left = editorRect ? rect.left - editorRect.left : rect.left;
        const top = editorRect ? rect.top - editorRect.top : rect.top;
        marker.style.left = `${left}px`;
        marker.style.top = `${top + (rect.height - 2)}px`;
        marker.style.width = `${Math.max(8, rect.width)}px`;
        marker.style.height = `2px`;
        marker.style.position = "absolute";
        marker.style.pointerEvents = "auto";
        marker.addEventListener("click", () => {
          const detail = document.createElement("div");
          detail.className = "pg4-diag-detail";
          detail.textContent = `${d.severity.toUpperCase()}: ${d.message}`;
          marker.appendChild(detail);
          setTimeout(() => detail.remove(), 4e3);
        });
        this.container.appendChild(marker);
        drawn++;
        if (drawn >= 200) break;
      }
      this.container.style.display = drawn ? "block" : "none";
    }
    clear() {
      this.diagnostics = [];
      this.container.innerHTML = "";
      this.container.style.display = "none";
    }
    setEditorDom(dom) {
      this.editorDom = dom;
    }
    destroy() {
      this.container.remove();
    }
    static injectStyles(shadow) {
      const style = document.createElement("style");
      style.textContent = `
      .pg4-diagnostics-overlay {
        position: absolute;
        pointer-events: none;
        top: 0;
        left: 0;
      }
      .pg4-diag {
        position: absolute;
        background-repeat: repeat-x;
        background-position: bottom;
        pointer-events: auto;
        cursor: help;
      }
      .pg4-diag-error {
        background-image: linear-gradient(to right, var(--pg4-error) 50%, transparent 50%);
        background-size: 6px 2px;
      }
      .pg4-diag-warning {
        background-image: linear-gradient(to right, var(--pg4-warn) 50%, transparent 50%);
        background-size: 6px 2px;
      }
      .pg4-diag::after {
        content: "";
        display: inline-block;
        position: absolute;
        top: -10px;
        left: 0;
        font-size: 9px;
        color: var(--pg4-error);
      }
      .pg4-diag-error::after { color: var(--pg4-error); content: "\u25CF"; }
      .pg4-diag-warning::after { color: var(--pg4-warn); content: "\u25CF"; }
      .pg4-diag-detail {
        position: absolute;
        top: 4px;
        left: 0;
        background: var(--pg4-bg);
        color: var(--pg4-fg);
        border: 1px solid var(--pg4-border);
        border-radius: 4px;
        padding: 4px 8px;
        font-size: 11px;
        z-index: 10;
        max-width: 320px;
        white-space: normal;
      }
    `;
      shadow.appendChild(style);
    }
  };

  // src/storage/chrome-storage.ts
  var KEYS = {
    hostAllowlist: "pg4.hostAllowlist",
    activeSnapshotByOrigin: "pg4.activeSnapshotByOrigin",
    settings: "pg4.settings",
    completionTriggerMode: "pg4.completionTriggerMode",
    pasteMode: "pg4.pasteMode",
    diagnosticsEnabled: "pg4.diagnosticsEnabled",
    dangerInterceptEnabled: "pg4.dangerInterceptEnabled"
  };
  var DEFAULT_SETTINGS = {
    completionTriggerMode: "auto",
    pasteMode: "on",
    diagnosticsEnabled: true,
    dangerInterceptEnabled: true,
    maxCandidates: 50,
    completionShortcut: "Ctrl+Space",
    historyRetentionDays: 90,
    smartPasteHintDismissed: false
  };
  async function getSettings() {
    const raw = await chrome.storage.local.get(KEYS.settings);
    const v = raw[KEYS.settings];
    return { ...DEFAULT_SETTINGS, ...v ?? {} };
  }

  // src/content/content-script.ts
  var Pg4ContentScript = class {
    nonce = newNonce();
    sessions = /* @__PURE__ */ new Map();
    activeEditorId = null;
    worker = null;
    settings = DEFAULT_SETTINGS;
    activeGraph = null;
    activeSnapshotId = null;
    activeOrigin = location.origin;
    hoverCard = null;
    // shared hover card (re-positioned per use)
    globalDiagnostics = null;
    initialized = false;
    executeClickInterceptor = null;
    async init() {
      if (this.initialized) return;
      this.initialized = true;
      try {
        ensureOverlayHost();
        const shadow = getShadow();
        CompletionMenu.injectStyles(shadow);
        DangerDialog.injectStyles(shadow);
        HoverCard.injectStyles(shadow);
        DiagnosticsOverlay.injectStyles(shadow);
        this.hoverCard = new HoverCard();
        await this.reloadSettings();
        onThemeChange(() => {
          for (const s of this.sessions.values()) {
            if (s.menu) this.refreshMenu(s);
          }
        });
        this.worker = await this.createWorker();
        await this.reloadActiveSnapshot();
        this.handNonceToBridge();
        window.addEventListener("message", this.onBridgeMessage);
        chrome.runtime.onMessage.addListener(this.onBackgroundMessage);
        this.attachExecuteInterceptor();
        document.addEventListener("paste", this.onPaste, true);
        document.addEventListener("keydown", this.onForceShortcut, true);
        window.addEventListener("pagehide", this.cleanup);
        window.addEventListener("beforeunload", this.cleanup);
      } catch (e) {
        console.warn("[pg4] content script init failed (pgAdmin4 will continue normally):", e);
      }
    }
    // --- Worker setup ---------------------------------------------------------
    async createWorker() {
      try {
        const url = chrome.runtime.getURL("parser-worker.js");
        let w;
        try {
          w = new Worker(url, { type: "module" });
        } catch {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`fetch parser-worker failed: ${res.status}`);
          const text = await res.text();
          const blob = new Blob([text], { type: "text/javascript" });
          w = new Worker(URL.createObjectURL(blob), { type: "module" });
        }
        const client = new WorkerRpcClient(w);
        void client.call("set-config", { maxCandidates: this.settings.maxCandidates });
        return client;
      } catch (e) {
        console.warn("[pg4] worker creation failed:", e);
        return null;
      }
    }
    // --- Bridge communication -------------------------------------------------
    handNonceToBridge() {
      try {
        window.dispatchEvent(
          new CustomEvent("pg4:init", { detail: { pg4: true, nonce: this.nonce } })
        );
      } catch {
      }
      document.documentElement.setAttribute("data-pg4-nonce", this.nonce);
    }
    sendToBridge(msg) {
      const full = {
        version: BRIDGE_PROTOCOL_VERSION,
        requestId: newRequestId(),
        source: CONTENT_SOURCE,
        nonce: this.nonce,
        ...msg
      };
      window.postMessage(full, "*");
    }
    onBridgeMessage = async (ev) => {
      if (ev.source !== window) return;
      const data = ev.data;
      if (!isBridgeMessage(data)) return;
      const msg = data;
      try {
        switch (msg.type) {
          case "editor-ready":
            await this.onEditorReady(msg.editorId);
            break;
          case "editor-state":
          case "editor-change":
            await this.onEditorState(msg.editorId, msg.sql, msg.cursor, msg.selection, msg.scrollRect, msg.transactionKind);
            break;
          case "editor-blur":
            this.onEditorBlur(msg.editorId);
            break;
          case "bridge-error":
            console.debug("[pg4] bridge error:", msg.code, msg.detail ?? "");
            break;
          case "executing-query":
            void this.onExecutingQuery(msg.editorId, msg.sql);
            break;
        }
      } catch (e) {
        console.warn("[pg4] bridge message handler failed:", e);
      }
    };
    async onEditorReady(editorId) {
      if (this.sessions.has(editorId)) {
        this.sendToBridge({ type: "request-state", editorId });
        return;
      }
      const editorDom = this.findEditorDomFor(editorId);
      const diagnostics = new DiagnosticsOverlay(editorDom);
      const hover = new HoverCard();
      const session = {
        editorId,
        state: { editorId, sql: "", cursor: 0, selection: { from: 0, to: 0 } },
        editorDom,
        menu: null,
        diagnostics,
        hover,
        lastReqId: null,
        completionDebounce: null,
        diagnosticsDebounce: null,
        hoverDebounce: null
      };
      this.sessions.set(editorId, session);
      this.activeEditorId = editorId;
      this.sendToBridge({ type: "request-state", editorId });
      await this.syncWorkerState();
      setTimeout(() => {
        if (!session.editorDom) {
          session.editorDom = this.findEditorDomFor(editorId);
          session.diagnostics.setEditorDom(session.editorDom);
        }
      }, 250);
    }
    findEditorDomFor(_editorId) {
      const editors = Array.from(document.querySelectorAll(".cm-editor"));
      const focused = editors.find((el) => el === document.activeElement || el.contains(document.activeElement));
      return focused ?? editors[0] ?? null;
    }
    async onEditorState(editorId, sql, cursor, selection, scrollRect, kind) {
      const session = this.sessions.get(editorId);
      if (!session) {
        await this.onEditorReady(editorId);
      }
      const s = this.sessions.get(editorId);
      if (!s) return;
      s.state = { editorId, sql, cursor, selection: { from: selection.from, to: selection.to } };
      s.scrollRect = scrollRect;
      this.activeEditorId = editorId;
      if (kind === "input" || kind === "paste") {
        this.scheduleCompletion(s, kind);
      } else if (kind === "selection") {
        if (s.menu) {
          this.closeMenu(s, "blur");
        }
      }
      if (this.settings.diagnosticsEnabled) {
        this.scheduleDiagnostics(s);
      }
      if (selection.from === selection.to) {
        this.scheduleHover(s);
      }
    }
    onEditorBlur(editorId) {
      const s = this.sessions.get(editorId);
      if (!s) return;
      this.closeMenu(s, "blur");
      s.hover.hide();
      s.diagnostics.clear();
    }
    async onExecutingQuery(editorId, sql) {
      const s = this.sessions.get(editorId);
      if (!s) return;
      const entry = {
        sql,
        executedAt: Date.now(),
        snapshotId: this.activeSnapshotId,
        origin: this.activeOrigin
      };
      try {
        await chrome.runtime.sendMessage({ type: "pg4:add-history", entry });
      } catch {
      }
    }
    // --- Completion -----------------------------------------------------------
    scheduleCompletion(session, _kind) {
      if (session.completionDebounce !== null) {
        clearTimeout(session.completionDebounce);
      }
      const sql = session.state.sql;
      const cursor = session.state.cursor;
      const trigger = computeTrigger(sql, cursor);
      const delay = trigger.immediate ? 0 : 30;
      session.completionDebounce = window.setTimeout(() => {
        session.completionDebounce = null;
        void this.requestCompletion(session, sql, cursor, trigger.force);
      }, delay);
    }
    async requestCompletion(session, sql, cursor, force) {
      if (!this.worker) return;
      if (this.settings.completionTriggerMode === "manual" && !force) {
        return;
      }
      if (!force) {
        const prefix = currentPrefix(sql, cursor);
        if (prefix.length < 2 && !isImmediateTriggerContext(sql, cursor)) return;
      }
      const reqId = newRequestId();
      session.lastReqId = reqId;
      try {
        const result = await this.worker.call("complete", {
          sql,
          cursor,
          editorId: session.editorId
        });
        if (session.lastReqId !== reqId) return;
        this.showOrUpdateMenu(session, result.items, result.context.from, result.context.to);
      } catch (e) {
        console.debug("[pg4] completion failed:", e);
      }
    }
    /** Force trigger completion (Ctrl+Space). */
    forceTriggerCompletion() {
      const editorId = this.activeEditorId;
      if (!editorId) return;
      const s = this.sessions.get(editorId);
      if (!s) return;
      void this.requestCompletion(
        s,
        s.state.sql,
        s.state.cursor,
        /* force */
        true
      );
    }
    showOrUpdateMenu(session, items, from, to) {
      if (items.length === 0) {
        this.closeMenu(session, "external");
        return;
      }
      const anchor = this.anchorForCursor(session);
      if (!anchor) {
        this.closeMenu(session, "external");
        return;
      }
      if (session.menu) {
        session.menu.update(items, { from, to }, anchor);
      } else {
        session.menu = new CompletionMenu({
          anchor,
          items,
          replaceRange: { from, to },
          onSelect: (item, range) => this.applyCompletion(session, item, range),
          onCancel: () => this.closeMenu(session, "external")
        });
      }
    }
    anchorForCursor(session) {
      const rect = session.scrollRect;
      if (rect) {
        return { left: rect.left, top: rect.top, bottom: rect.bottom };
      }
      if (session.editorDom) {
        const r = session.editorDom.getBoundingClientRect();
        return { left: r.left + 8, top: r.top + 8, bottom: r.top + 32 };
      }
      return null;
    }
    applyCompletion(session, item, range) {
      this.sendToBridge({
        type: "apply-completion",
        editorId: session.editorId,
        from: range.from,
        to: range.to,
        insert: item.insertText
      });
      if (this.worker) {
        const symbolKey = item.detail ?? item.label;
        void this.worker.call("record-usage", { symbolKey });
        if (this.activeSnapshotId) {
          try {
            void chrome.runtime.sendMessage({
              type: "pg4:record-usage",
              symbolKey,
              snapshotId: this.activeSnapshotId
            });
          } catch {
          }
        }
      }
      this.closeMenu(session, "external");
    }
    closeMenu(session, reason) {
      if (!session.menu) return;
      session.menu.destroy(reason);
      session.menu = null;
    }
    refreshMenu(session) {
      if (!session.menu) return;
      const anchor = this.anchorForCursor(session);
      if (anchor) session.menu.position(anchor);
    }
    // --- Diagnostics ----------------------------------------------------------
    scheduleDiagnostics(session) {
      if (session.diagnosticsDebounce !== null) clearTimeout(session.diagnosticsDebounce);
      const sql = session.state.sql;
      const cursor = session.state.cursor;
      session.diagnosticsDebounce = window.setTimeout(async () => {
        session.diagnosticsDebounce = null;
        if (!this.worker) return;
        try {
          const result = await this.worker.call("diagnose", { sql, cursor });
          const coordsOf = (offset) => {
            return session.scrollRect ?? null;
          };
          await session.diagnostics.update(result.diagnostics, coordsOf);
        } catch (e) {
          console.debug("[pg4] diagnostics failed:", e);
        }
      }, 300);
    }
    // --- Hover ----------------------------------------------------------------
    scheduleHover(session) {
      if (session.hoverDebounce !== null) clearTimeout(session.hoverDebounce);
      const sql = session.state.sql;
      const cursor = session.state.cursor;
      session.hoverDebounce = window.setTimeout(async () => {
        session.hoverDebounce = null;
        if (!this.worker) return;
        const token = tokenAtCursor(sql, cursor);
        if (!token) {
          session.hover.hide();
          return;
        }
        try {
          const result = await this.worker.call("resolve-hover", { symbol: token, sql, cursor });
          if (result.documentation && session.scrollRect && this.hoverCard) {
            const r = session.scrollRect;
            this.hoverCard.show(result.documentation, {
              left: r.left,
              top: r.top,
              bottom: r.bottom
            });
          } else {
            session.hover.hide();
          }
        } catch {
          session.hover.hide();
        }
      }, 350);
    }
    // --- Smart paste (SPEC §7.1) ----------------------------------------------
    onPaste = async (ev) => {
      if (this.settings.pasteMode === "off") return;
      if (!ev.clipboardData) return;
      const text = ev.clipboardData.getData("text/plain");
      if (!text) return;
      if (text.includes("\n") || text.length > 256) return;
      if (text.includes("'") || text.includes('"')) return;
      const editorId = this.activeEditorId;
      if (!editorId) return;
      const session = this.sessions.get(editorId);
      if (!session) return;
      const sql = session.state.sql;
      const cursor = session.state.cursor;
      const ctx = classifyPasteContext(sql, cursor);
      if (!ctx.wrap) return;
      ev.preventDefault();
      ev.stopPropagation();
      const wrapped = wrapPaste(text, ctx);
      this.sendToBridge({
        type: "apply-completion",
        editorId,
        from: cursor,
        to: cursor,
        insert: wrapped
      });
      if (!this.settings.smartPasteHintDismissed && this.settings.pasteMode === "on") {
        this.showSmartPasteHintOnce();
      }
    };
    smartPasteHintShown = false;
    showSmartPasteHintOnce() {
      if (this.smartPasteHintShown) return;
      this.smartPasteHintShown = true;
      const shadow = getShadow();
      const toast = document.createElement("div");
      toast.className = "pg4-toast";
      toast.textContent = "PG4 wrapped your paste with quotes. Disable in extension options.";
      toast.style.cssText = "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--pg4-bg);color:var(--pg4-fg);border:1px solid var(--pg4-border);border-radius:6px;padding:8px 12px;font-size:12px;font-family:var(--pg4-font);box-shadow:var(--pg4-shadow);z-index:2147483647;pointer-events:auto;";
      shadow.appendChild(toast);
      setTimeout(() => toast.remove(), 4e3);
    }
    // --- Danger intercept (SPEC §9.3) -----------------------------------------
    attachExecuteInterceptor() {
      const selectors = [
        'button[aria-label*="Execute" i]',
        'button[aria-label*="Run" i]',
        'button[title*="Execute" i]',
        'button[title*="Run" i]',
        'button[data-action="execute-query"]',
        'a[data-action="execute-query"]',
        ".pg4-execute-button"
      ];
      const matches = (el) => {
        if (!el) return false;
        return selectors.some((sel) => {
          try {
            return el.matches?.(sel) || !!el.closest?.(sel);
          } catch {
            return false;
          }
        });
      };
      this.executeClickInterceptor = (ev) => {
        if (!this.settings.dangerInterceptEnabled) return;
        const target = ev.target;
        if (!matches(target)) return;
        const session = this.activeEditorId ? this.sessions.get(this.activeEditorId) : null;
        if (!session) return;
        const sql = session.state.sql;
        if (!sql.trim()) return;
        const danger = quickDetectDangerSync(sql);
        if (!danger.detected) return;
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        const dialog = new DangerDialog({
          sql,
          result: danger,
          onConfirm: (mode) => {
            if (mode === "explain") {
              const explain = `EXPLAIN ${sql.trim()}`;
              this.sendToBridge({
                type: "apply-completion",
                editorId: session.editorId,
                from: 0,
                to: sql.length,
                insert: explain
              });
            } else {
              setTimeout(() => {
                const t = target;
                t.click();
              }, 0);
            }
          },
          onCancel: () => {
          }
        });
      };
      document.addEventListener(
        "click",
        this.executeClickInterceptor,
        /* capture */
        true
      );
    }
    // --- Background communication ---------------------------------------------
    onBackgroundMessage = (msg, _sender, _sendResponse) => {
      if (!msg || typeof msg !== "object") return;
      const m = msg;
      switch (m.type) {
        case "pg4:settings-changed":
          void this.reloadSettings();
          break;
        case "pg4:snapshot-changed":
          void this.reloadActiveSnapshot();
          break;
        case "pg4:snippets-changed":
          void this.reloadSnippets();
          break;
        case "pg4:focus-trigger":
          this.forceTriggerCompletion();
          break;
      }
    };
    async reloadSettings() {
      try {
        this.settings = await getSettings();
      } catch {
        this.settings = DEFAULT_SETTINGS;
      }
      if (this.worker) {
        void this.worker.call("set-config", { maxCandidates: this.settings.maxCandidates });
      }
    }
    async reloadSnippets() {
      if (!this.worker) return;
      try {
        const snippets = await chrome.runtime.sendMessage({ type: "pg4:list-snippets" });
        if (snippets) void this.worker.call("set-snippets", { snippets });
      } catch {
      }
    }
    async reloadActiveSnapshot() {
      try {
        const resp = await chrome.runtime.sendMessage({
          type: "pg4:get-active-context",
          origin: this.activeOrigin
        });
        if (!resp) {
          console.info("[pg4] content: no active context returned for origin", this.activeOrigin);
          return;
        }
        this.activeSnapshotId = resp.snapshotId;
        this.activeGraph = resp.graph;
        console.info("[pg4] content: active context loaded", {
          origin: this.activeOrigin,
          snapshotId: resp.snapshotId,
          hasGraph: !!resp.graph,
          schemas: resp.graph ? Object.keys(resp.graph.schemas).length : 0,
          snippets: resp.snippets.length
        });
        if (this.worker) {
          await this.worker.call("set-active-graph", { graph: resp.graph });
          await this.worker.call("set-usage", { usage: resp.usage });
          await this.worker.call("set-snippets", { snippets: resp.snippets });
        }
      } catch (e) {
        console.debug("[pg4] reload active snapshot failed:", e);
      }
    }
    async syncWorkerState() {
      if (!this.worker) return;
      await this.worker.call("set-active-graph", { graph: this.activeGraph });
      await this.worker.call("set-config", { maxCandidates: this.settings.maxCandidates });
    }
    // --- Forced completion shortcut ------------------------------------------
    onForceShortcut = (ev) => {
      const want = this.settings.completionShortcut || "Ctrl+Space";
      const parts = want.toLowerCase().split("+").map((s) => s.trim());
      const needCtrl = parts.includes("ctrl");
      const needCmd = parts.includes("cmd") || parts.includes("meta");
      const needAlt = parts.includes("alt");
      const needShift = parts.includes("shift");
      const key = parts[parts.length - 1] ?? "space";
      const code = key === "space" ? " " : key;
      if (ev.ctrlKey !== needCtrl) return;
      if (ev.metaKey !== needCmd && needCmd) return;
      if (ev.altKey !== needAlt) return;
      if (ev.shiftKey !== needShift) return;
      if (ev.key.toLowerCase() !== code.toLowerCase() && ev.code.toLowerCase() !== `key${code}`.toLowerCase()) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.forceTriggerCompletion();
    };
    // --- Cleanup --------------------------------------------------------------
    cleanup = () => {
      try {
        if (this.executeClickInterceptor) {
          document.removeEventListener("click", this.executeClickInterceptor, true);
          this.executeClickInterceptor = null;
        }
        document.removeEventListener("paste", this.onPaste, true);
        document.removeEventListener("keydown", this.onForceShortcut, true);
        window.removeEventListener("message", this.onBridgeMessage);
        chrome.runtime.onMessage.removeListener(this.onBackgroundMessage);
        for (const s of this.sessions.values()) {
          s.diagnostics.destroy();
          s.hover.destroy();
          s.menu?.destroy("external");
        }
        this.sessions.clear();
        this.worker?.terminate();
        this.worker = null;
        this.hoverCard?.destroy();
      } catch {
      }
    };
  };
  function computeTrigger(sql, cursor) {
    return { immediate: isImmediateTriggerContext(sql, cursor), force: false };
  }
  function currentPrefix(sql, cursor) {
    let i = cursor;
    while (i > 0) {
      const ch = sql[i - 1];
      if (/[A-Za-z0-9_]/.test(ch)) {
        i--;
        continue;
      }
      break;
    }
    return sql.slice(i, cursor);
  }
  function isImmediateTriggerContext(sql, cursor) {
    const before = sql.slice(Math.max(0, cursor - 3), cursor);
    return /(\.|->>|->|#>>|#>)$/.test(before);
  }
  function tokenAtCursor(sql, cursor) {
    let start = cursor;
    let end = cursor;
    while (start > 0 && /[A-Za-z0-9_.]/.test(sql[start - 1])) start--;
    while (end < sql.length && /[A-Za-z0-9_.]/.test(sql[end])) end++;
    if (start === end) return null;
    return sql.slice(start, end);
  }
  function classifyPasteContext(sql, cursor) {
    const before = sql.slice(Math.max(0, cursor - 32), cursor).trimEnd();
    if (/=\s*$/.test(before) || /VALUES\s*\(/i.test(before) || /IN\s*\(/i.test(before)) {
      return { wrap: true, kind: "string" };
    }
    if (/(SELECT|SELECT DISTINCT)\s+$/i.test(before) || /,\s*$/i.test(before)) {
      return { wrap: true, kind: "identifier" };
    }
    return { wrap: false };
  }
  function wrapPaste(text, ctx) {
    if (!ctx.wrap) return text;
    if (ctx.kind === "string") {
      return `'${text.replace(/'/g, "''")}'`;
    }
    if (/[A-Z]/.test(text) || /\s/.test(text) || /[^A-Za-z0-9_]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }
  function quickDetectDangerSync(sql) {
    const reasons = [];
    const targetObjects = [];
    let kind = null;
    const upper = sql.toUpperCase();
    const noComment = sql.replace(/--[^\n]*\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, " ");
    const stmt = noComment.trim();
    const stmtUpper = stmt.toUpperCase();
    if (/^\s*DELETE\s+FROM\b/i.test(stmt) || /^\s*DELETE\b/i.test(stmt)) {
      if (!/\bWHERE\b/i.test(stmt)) {
        kind = "DELETE without WHERE";
        reasons.push("DELETE statement has no WHERE clause \u2014 affects all rows.");
        const m = stmt.match(/DELETE\s+FROM\s+([A-Za-z_][\w.]*)/i);
        if (m) targetObjects.push(m[1]);
      } else if (/\bWHERE\s+(1\s*=\s*1|TRUE\s*\b|'x'\s*=\s*'x'\b|0\s*=\s*0\b)/i.test(stmt)) {
        kind = "DELETE with tautology WHERE";
        reasons.push("WHERE clause appears to always be true \u2014 affects all rows.");
      }
    }
    if (/^\s*UPDATE\b/i.test(stmt)) {
      if (!/\bWHERE\b/i.test(stmt)) {
        kind = "UPDATE without WHERE";
        reasons.push("UPDATE statement has no WHERE clause \u2014 affects all rows.");
        const m = stmt.match(/UPDATE\s+([A-Za-z_][\w.]*)/i);
        if (m) targetObjects.push(m[1]);
      }
    }
    if (/^\s*TRUNCATE\b/i.test(stmt)) {
      kind = "TRUNCATE";
      reasons.push("TRUNCATE removes all rows quickly without per-row logging.");
      const m = stmt.match(/TRUNCATE\s+(?:TABLE\s+)?([A-Za-z_][\w.]*)/i);
      if (m) targetObjects.push(m[1]);
    }
    if (/^\s*DROP\s+(TABLE|SCHEMA|DATABASE)\b/i.test(stmt)) {
      const m = stmt.match(/DROP\s+(TABLE|SCHEMA|DATABASE)\s+([A-Za-z_][\w.]*)/i);
      kind = m ? `DROP ${m[1]}` : "DROP";
      reasons.push(`DROP ${m?.[1] ?? "object"} permanently removes the object.`);
      if (m) targetObjects.push(m[2]);
    }
    if (/ALTER\s+TABLE\b/i.test(stmtUpper) && /DROP\s+COLUMN\b/i.test(stmtUpper)) {
      kind = "ALTER TABLE DROP COLUMN";
      reasons.push("Dropping a column is destructive and not reversible without backup.");
      const m = stmt.match(/ALTER\s+TABLE\s+([A-Za-z_][\w.]*)/i);
      if (m) targetObjects.push(m[1]);
    }
    return { detected: !!kind, kind, reasons, targetObjects };
  }
  var cs = new Pg4ContentScript();
  void cs.init();
})();
