"use strict";
(() => {
  // src/types/messages.ts
  var BRIDGE_PROTOCOL_VERSION = 1;
  var BRIDGE_SOURCE = "pg4-bridge";
  var CONTENT_SOURCE = "pg4-content";
  var MAX_PAGE_PAYLOAD_CHARS = 15e5;
  function isExtensionToBridgeMessage(v) {
    if (!v || typeof v !== "object") return false;
    const m = v;
    return m.version === BRIDGE_PROTOCOL_VERSION && typeof m.requestId === "string" && m.source === CONTENT_SOURCE && typeof m.nonce === "string";
  }
  function newRequestId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // src/bridge/main-world-bridge.ts
  function findEditorViewCtor() {
    const w = window;
    const paths = [
      ["codemirror", "EditorView"],
      ["CodeMirror", "EditorView"],
      ["cm", "EditorView"],
      ["CM", "EditorView"],
      ["EditorView"],
      ["__codemirror", "EditorView"]
    ];
    for (const p of paths) {
      let cur = w;
      let ok = true;
      for (const seg of p) {
        cur = cur?.[seg];
        if (cur == null) {
          ok = false;
          break;
        }
      }
      if (ok && typeof cur === "function") return cur;
    }
    return null;
  }
  function findViewOnElement(el) {
    const anyEl = el;
    const v = anyEl?.cmView;
    if (v && typeof v.dispatch === "function" && v.state && v.state.doc) return v;
    const alt = anyEl?.view ?? anyEl?.editor;
    if (alt && typeof alt.dispatch === "function" && alt.state && alt.state.doc) return alt;
    const Ctor = findEditorViewFromWebpack();
    if (Ctor) {
      try {
        const found = Ctor.findFromDOM(el);
        if (found && typeof found.dispatch === "function" && found.state && found.state.doc) return found;
      } catch (e) {
        console.warn("[pg4] bridge: findFromDOM failed:", e);
      }
    }
    return null;
  }
  var webpackEditorView = void 0;
  function findEditorViewFromWebpack() {
    if (webpackEditorView !== void 0) return webpackEditorView;
    webpackEditorView = null;
    try {
      const chunks = window.webpackChunk;
      if (!Array.isArray(chunks) || chunks.length === 0) return null;
      const allModules = {};
      for (const c of chunks) {
        if (!Array.isArray(c)) continue;
        const mods = c[1];
        if (mods && typeof mods === "object") {
          for (const k of Object.keys(mods)) {
            if (!(k in allModules)) allModules[k] = mods[k];
          }
        }
      }
      const cache = {};
      const miniRequire = (id) => {
        if (cache[id]) return cache[id].exports;
        const factory = allModules[id];
        if (!factory) throw new Error("no module " + id);
        const module = { exports: {} };
        cache[id] = module;
        try {
          factory(module, module.exports, miniRequire);
        } catch (e) {
          delete cache[id];
          throw e;
        }
        return module.exports;
      };
      for (const id of Object.keys(allModules)) {
        try {
          const ex = miniRequire(id);
          if (ex && typeof ex === "object") {
            for (const k of Object.keys(ex)) {
              const v = ex[k];
              if (typeof v === "function" && typeof v.findFromDOM === "function") {
                webpackEditorView = v;
                console.info("[pg4] bridge: EditorView found via webpack (module", id + ", export", k + ")");
                return webpackEditorView;
              }
            }
          }
        } catch {
        }
      }
    } catch (e) {
      console.warn("[pg4] bridge: webpack EditorView discovery failed:", e);
    }
    return null;
  }
  var MainWorldBridge = class {
    editors = /* @__PURE__ */ new Map();
    domToEditorId = /* @__PURE__ */ new WeakMap();
    nonce = null;
    observer = null;
    started = false;
    discoveryTimer = null;
    maxEditors = 16;
    // Detection: only run discovery on hosts that look like pgAdmin4. We can't read origin allowlist
    // here (isolated world concern); we just attempt discovery and let content script decide binding.
    pgAdminDetected = null;
    // Set once a "no editor found" report has been shown, to avoid log spam from MutationObserver.
    reportedNoEditor = false;
    start() {
      if (this.started) return;
      this.started = true;
      console.info("[pg4] bridge: started (MAIN world)");
      window.addEventListener("message", this.onWindowMessage);
      window.addEventListener("pg4:extension-command", this.onExtensionCommand);
      this.scheduleDiscovery(0);
      this.observer = new MutationObserver(() => {
        this.scheduleDiscovery(50);
      });
      this.observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    // --- Discovery -------------------------------------------------------------
    scheduleDiscovery(delayMs) {
      if (this.discoveryTimer !== null) return;
      this.discoveryTimer = window.setTimeout(() => {
        this.discoveryTimer = null;
        void this.discoverEditors();
      }, delayMs);
    }
    detectPgAdmin() {
      if (this.pgAdminDetected !== null) return this.pgAdminDetected;
      const html = document.documentElement;
      const w = window;
      const markers = [
        () => !!w.pgAdmin,
        () => !!w.pgBrowser,
        () => !!html.querySelector("[data-pgadmin-role], .pg-admin"),
        () => document.title.toLowerCase().includes("pgadmin"),
        () => !!html.querySelector('link[href*="pgadmin"]'),
        () => !!document.querySelector('script[src*="pgadmin"]')
      ];
      this.pgAdminDetected = markers.some((fn) => {
        try {
          return fn();
        } catch {
          return false;
        }
      });
      return this.pgAdminDetected;
    }
    discoverEditors() {
      const ctor = findEditorViewCtor();
      if (!ctor) {
        this.notifyBridgeError("no-codemirror-ctor", "CodeMirror 6 EditorView constructor not found on window");
      }
      const candidates = [];
      document.querySelectorAll(".cm-editor").forEach((el) => candidates.push(el));
      document.querySelectorAll("[class*='cm-editor'], [class*='CodeMirror'], [data-pg-cm]").forEach((el) => candidates.push(el));
      const seen = /* @__PURE__ */ new Set();
      for (const el of candidates) {
        if (seen.has(el)) continue;
        seen.add(el);
        this.tryAdopt(el);
      }
      for (const [id, tracked] of this.editors) {
        if (tracked.destroyed || !tracked.dom.isConnected) {
          this.detachEditor(id, "dom-removed");
        }
      }
      if (this.editors.size === 0) {
        if (!this.reportedNoEditor) {
          console.info(
            `[pg4] bridge: no CodeMirror 6 editor found (scanned ${candidates.length} element(s)); keeping watch`
          );
          this.reportedNoEditor = true;
        }
      } else {
        this.reportedNoEditor = false;
      }
    }
    tryAdopt(el) {
      if (this.domToEditorId.has(el)) return;
      if (this.editors.size >= this.maxEditors) return;
      const view = findViewOnElement(el);
      if (!view) return;
      if (!view.state?.doc || typeof view.dispatch !== "function" || typeof view.coordsAtPos !== "function") return;
      const editorId = `cm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      this.domToEditorId.set(el, editorId);
      console.info("[pg4] bridge: editor adopted", editorId);
      this.reportedNoEditor = false;
      const tracked = {
        editorId,
        view,
        dom: el,
        lastSentSql: "",
        lastSentCursor: -1,
        lastSentFrom: -1,
        lastSentTo: -1,
        unsubscribe: () => {
        },
        destroyed: false
      };
      this.attachUpdateListener(tracked);
      this.editors.set(editorId, tracked);
      this.notifyBridgeError;
      this.send({
        version: BRIDGE_PROTOCOL_VERSION,
        requestId: newRequestId(),
        source: BRIDGE_SOURCE,
        type: "editor-ready",
        editorId,
        cmVersion: this.detectCMVersion(view)
      });
      this.sendEditorState(tracked, "input");
    }
    detectCMVersion(view) {
      const anyView = view;
      return anyView?.constructor?.cmVersion ?? anyView?._cmVersion ?? void 0;
    }
    attachUpdateListener(tracked) {
      const view = tracked.view;
      const originalDispatch = view.dispatch.bind(view);
      const bridge = this;
      view.dispatch = function(spec) {
        originalDispatch(spec);
        if (tracked.destroyed) return;
        const s = spec;
        let kind = "input";
        if (s?.userEvent === "select" || s?.userEvent === "delete.selection") kind = "selection";
        else if (s?.userEvent === "input.paste" || s?.userEvent === "paste") kind = "paste";
        else if (typeof s?.userEvent === "string" && s.userEvent.startsWith("input")) kind = "input";
        bridge.sendEditorState(tracked, kind);
      };
      const onFocus = () => {
        if (tracked.destroyed) return;
        bridge.sendEditorState(tracked, "selection");
      };
      tracked.dom.addEventListener("focusin", onFocus, true);
      tracked.unsubscribe = () => {
        try {
          view.dispatch = originalDispatch;
        } catch {
        }
        tracked.dom.removeEventListener("focusin", onFocus, true);
      };
    }
    detachEditor(editorId, reason) {
      const tracked = this.editors.get(editorId);
      if (!tracked) return;
      tracked.destroyed = true;
      try {
        tracked.unsubscribe();
      } catch {
      }
      this.editors.delete(editorId);
      this.domToEditorId.delete(tracked.dom);
      this.send({
        version: BRIDGE_PROTOCOL_VERSION,
        requestId: newRequestId(),
        source: BRIDGE_SOURCE,
        type: "editor-blur",
        editorId
      });
    }
    sendEditorState(tracked, transactionKind) {
      const view = tracked.view;
      let sql;
      let cursor;
      let from;
      let to;
      try {
        const doc = view.state.doc;
        sql = doc.toString();
        cursor = view.state.selection.main.head;
        from = view.state.selection.main.from;
        to = view.state.selection.main.to;
      } catch {
        return;
      }
      if (sql.length > MAX_PAGE_PAYLOAD_CHARS) {
        const around = 1e5;
        const start = Math.max(0, cursor - around);
        sql = sql.slice(start, start + around);
      }
      if (sql === tracked.lastSentSql && cursor === tracked.lastSentCursor && from === tracked.lastSentFrom && to === tracked.lastSentTo) {
        return;
      }
      tracked.lastSentSql = sql;
      tracked.lastSentCursor = cursor;
      tracked.lastSentFrom = from;
      tracked.lastSentTo = to;
      let scrollRect;
      try {
        const coords = view.coordsAtPos(cursor);
        if (coords) {
          scrollRect = {
            left: coords.left,
            top: coords.top,
            right: coords.right,
            bottom: coords.bottom,
            width: coords.right - coords.left,
            height: coords.bottom - coords.top
          };
        }
      } catch {
      }
      const type = transactionKind === "input" ? "editor-change" : "editor-state";
      this.send({
        version: BRIDGE_PROTOCOL_VERSION,
        requestId: newRequestId(),
        source: BRIDGE_SOURCE,
        type,
        editorId: tracked.editorId,
        sql,
        cursor,
        selection: { from, to: to === from ? cursor : to },
        transactionKind,
        scrollRect
      });
    }
    // --- Outbound to content script (ISOLATED world) ---------------------------
    send(msg) {
      window.postMessage(msg, "*");
    }
    notifyBridgeError(code, detail) {
      this.send({
        version: BRIDGE_PROTOCOL_VERSION,
        requestId: newRequestId(),
        source: BRIDGE_SOURCE,
        type: "bridge-error",
        code,
        detail
      });
    }
    // --- Inbound from content script (extension-controlled) --------------------
    onWindowMessage = (ev) => {
      if (ev.source !== window) return;
      const data = ev.data;
      if (!isExtensionToBridgeMessage(data)) return;
      if (this.nonce && data.nonce !== this.nonce) {
        this.notifyBridgeError("nonce-mismatch", "extension command nonce mismatch");
        return;
      }
      const msg = data;
      switch (msg.type) {
        case "apply-completion":
          this.handleApplyCompletion(msg);
          break;
        case "request-state":
          this.handleRequestState(msg);
          break;
        case "focus":
          this.handleFocus(msg);
          break;
        case "teardown":
          this.handleTeardown(msg);
          break;
      }
    };
    onExtensionCommand = (ev) => {
      const detail = ev.detail;
      if (!isExtensionToBridgeMessage(detail)) return;
      const fakeEvent = new MessageEvent("message", { source: window, data: detail });
      this.onWindowMessage(fakeEvent);
    };
    handleApplyCompletion(msg) {
      const tracked = this.editors.get(msg.editorId);
      if (!tracked || tracked.destroyed) {
        this.notifyBridgeError("editor-not-found", `apply-completion: editor ${msg.editorId} not tracked`);
        return;
      }
      try {
        tracked.view.dispatch({
          changes: { from: msg.from, to: msg.to, insert: msg.insert },
          // Mark as user input so CM6 history (undo/redo) records it.
          userEvent: "input"
        });
      } catch (e) {
        this.notifyBridgeError("apply-completion-failed", e?.message ?? String(e));
      }
    }
    handleRequestState(msg) {
      const tracked = this.editors.get(msg.editorId);
      if (!tracked || tracked.destroyed) return;
      this.sendEditorState(tracked, "selection");
    }
    handleFocus(msg) {
      const tracked = this.editors.get(msg.editorId);
      if (!tracked || tracked.destroyed) return;
      try {
        tracked.view.focus();
      } catch {
      }
    }
    handleTeardown(msg) {
      this.detachEditor(msg.editorId, "teardown");
    }
    // --- Public API used by content script via postMessage ----------------------
    // Content script sets the nonce once after initialization; from then on,
    // only its messages are honored for write operations.
    setNonce(nonce) {
      this.nonce = nonce;
    }
    // Stats / introspection (used by popup/options via content-script relay if needed).
    getTrackedEditorIds() {
      return Array.from(this.editors.keys());
    }
  };
  var BRIDGE = new MainWorldBridge();
  window.addEventListener("pg4:init", (ev) => {
    const detail = ev.detail;
    if (detail?.pg4 && typeof detail.nonce === "string") {
      BRIDGE.setNonce(detail.nonce);
    }
  });
  window.__pg4Bridge = {
    setNonce: (nonce) => BRIDGE.setNonce(nonce),
    ids: () => BRIDGE.getTrackedEditorIds()
  };
  try {
    BRIDGE.start();
  } catch (e) {
    window.postMessage(
      {
        version: BRIDGE_PROTOCOL_VERSION,
        requestId: newRequestId(),
        source: BRIDGE_SOURCE,
        type: "bridge-error",
        code: "bootstrap-failed",
        detail: e?.message ?? String(e)
      },
      "*"
    );
  }
})();
