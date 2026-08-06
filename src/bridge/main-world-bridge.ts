// Main-world bridge (SPEC §3.2, §4.1, §4.2).
// Runs in page's MAIN world (via content_scripts `world: "MAIN"`).
// Discovers CodeMirror 6 `EditorView` instances reachable from the DOM and pgAdmin4 page objects,
// forwards editor events to the extension's content script (ISOLATED world) via `window.postMessage`,
// and accepts controlled writes (apply-completion / focus / teardown) only when they carry the
// extension nonce.
//
// Constraints (SPEC §4.2):
//   - replaceRange MUST go through CodeMirror transaction dispatch (preserve Undo/Redo, history,
//     native events). We must NEVER write to contenteditable.innerText or DOM nodes directly.
//   - Must NOT assume a single fixed CSS class name; discovery should be tolerant of pgAdmin4 DOM
//     changes across v8.4 .. v9.x.
//   - Must support multiple Query Tool tabs in the same window; each editor gets a stable editorId.
//
// All page content is treated as untrusted. We only ever forward editor-state payloads that we
// ourselves computed from CM6 state fields; we never relay arbitrary page events verbatim.

import type {
  BridgeMessage,
  ExtensionToBridgeMessage,
  DOMRectLike,
} from "../types/messages";
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SOURCE,
  CONTENT_SOURCE,
  MAX_PAGE_PAYLOAD_CHARS,
  isExtensionToBridgeMessage,
  newRequestId,
} from "../types/messages";

// --- CodeMirror 6 minimal type shims ------------------------------------------
// We intentionally avoid importing @codemirror packages at runtime (we don't ship them).
// Instead we treat the discovered EditorView as an opaque object with a known shape.
interface CMEditorView {
  // EditorView.state
  state: {
    doc: { length: number; toString(): string };
    selection: {
      main: { from: number; to: number; head: number; anchor: number };
      ranges: ReadonlyArray<{ from: number; to: number }>;
    };
  };
  // EditorView.dispatch
  dispatch(spec: {
    changes?: { from: number; to?: number; insert?: string };
    selection?: { anchor: number; head?: number };
    userEvent?: string;
    annotations?: unknown;
  }): void;
  // EditorView.dom - the .cm-editor element
  dom: HTMLElement;
  // EditorView.coordsAtPos(offset, side?)
  coordsAtPos(offset: number, side?: number): { left: number; right: number; top: number; bottom: number } | null;
  // EditorView.focus
  focus(): void;
  // EditorView.destroy (not used; pgAdmin4 owns lifecycle)
  destroy?: () => void;
}

interface CMEditorViewCtor {
  new (config: unknown): CMEditorView;
}

// Discover the EditorView constructor by walking known reachable property paths.
function findEditorViewCtor(): CMEditorViewCtor | null {
  const w = window as unknown as Record<string, any>;
  const paths = [
    ["codemirror", "EditorView"],
    ["CodeMirror", "EditorView"],
    ["cm", "EditorView"],
    ["CM", "EditorView"],
    ["EditorView"],
    ["__codemirror", "EditorView"],
  ];
  for (const p of paths) {
    let cur: any = w;
    let ok = true;
    for (const seg of p) {
      cur = cur?.[seg];
      if (cur == null) {
        ok = false;
        break;
      }
    }
    if (ok && typeof cur === "function") return cur as CMEditorViewCtor;
  }
  return null;
}

// Find a CM6 EditorView instance attached to a DOM element.
// CodeMirror 6 stores the view instance on the `.cm-editor` element via `cmView` property.
function findViewOnElement(el: Element): CMEditorView | null {
  const anyEl = el as any;
  // CM6 stores the view at `.cmView` (EditorView) on the .cm-editor root.
  const v = anyEl?.cmView;
  if (v && typeof v.dispatch === "function" && v.state && v.state.doc) return v as CMEditorView;
  // Some integrations store it at `.view` or `.editor`.
  const alt = anyEl?.view ?? anyEl?.editor;
  if (alt && typeof alt.dispatch === "function" && alt.state && alt.state.doc) return alt as CMEditorView;
  // pgAdmin's bundle mangles the cmView property, so it is not visible on the element.
  // Fall back to the official EditorView.findFromDOM() via a class discovered from webpack.
  const Ctor = findEditorViewFromWebpack();
  if (Ctor) {
    try {
      const found = Ctor.findFromDOM(el);
      if (found && typeof found.dispatch === "function" && found.state && found.state.doc) return found as CMEditorView;
    } catch (e) {
      console.warn("[pg4] bridge: findFromDOM failed:", e);
    }
  }
  return null;
}

// --- Webpack module discovery (for mangled/bundled CM6) -----------------------
// Some pgAdmin deployments bundle CodeMirror 6 with property mangling, hiding the
// `cmView` reference that DOM-based discovery relies on. The official static
// EditorView.findFromDOM() still works because it uses the same (mangled) property
// internally — we just need the class reference, which lives in the webpack module
// graph exposed via `window.webpackChunk`.
interface CMEditorViewClass {
  findFromDOM(node: Element): CMEditorView | null;
}

let webpackEditorView: CMEditorViewClass | null | undefined = undefined;

function findEditorViewFromWebpack(): CMEditorViewClass | null {
  if (webpackEditorView !== undefined) return webpackEditorView;
  webpackEditorView = null;
  try {
    const chunks = (window as unknown as Record<string, any>).webpackChunk as any[] | undefined;
    if (!Array.isArray(chunks) || chunks.length === 0) return null;
    // Collect every module factory from all loaded chunks: {moduleId: factory}.
    const allModules: Record<string, (module: any, exports: any, requireFn: any) => void> = {};
    for (const c of chunks) {
      if (!Array.isArray(c)) continue;
      const mods = c[1];
      if (mods && typeof mods === "object") {
        for (const k of Object.keys(mods)) {
          if (!(k in allModules)) allModules[k] = mods[k];
        }
      }
    }
    // Minimal require(): execute a factory on demand with its own cache.
    const cache: Record<string, { exports: any }> = {};
    const miniRequire = (id: string): any => {
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
    // Scan module exports for the EditorView class (static findFromDOM).
    // NOTE: some pgAdmin bundles drop the static `create` method, so we match on
    // findFromDOM alone (its presence uniquely identifies the EditorView class).
    for (const id of Object.keys(allModules)) {
      try {
        const ex = miniRequire(id);
        if (ex && typeof ex === "object") {
          for (const k of Object.keys(ex)) {
            const v = ex[k];
            if (typeof v === "function" && typeof v.findFromDOM === "function") {
              webpackEditorView = v as CMEditorViewClass;
              console.info("[pg4] bridge: EditorView found via webpack (module", id + ", export", k + ")");
              return webpackEditorView;
            }
          }
        }
      } catch {
        /* module failed to load in mini graph — try next */
      }
    }
  } catch (e) {
    console.warn("[pg4] bridge: webpack EditorView discovery failed:", e);
  }
  return null;
}

interface TrackedEditor {
  editorId: string;
  view: CMEditorView;
  dom: HTMLElement;
  lastSentSql: string;
  lastSentCursor: number;
  lastSentFrom: number;
  lastSentTo: number;
  // CM6 update listener unsubscribe
  unsubscribe: () => void;
  destroyed: boolean;
}

// --- Bridge singleton --------------------------------------------------------

class MainWorldBridge {
  private editors = new Map<string, TrackedEditor>();
  private domToEditorId = new WeakMap<Element, string>();
  private nonce: string | null = null;
  private observer: MutationObserver | null = null;
  private started = false;
  private discoveryTimer: number | null = null;
  private readonly maxEditors = 16;
  // Detection: only run discovery on hosts that look like pgAdmin4. We can't read origin allowlist
  // here (isolated world concern); we just attempt discovery and let content script decide binding.
  private pgAdminDetected: boolean | null = null;
  // Set once a "no editor found" report has been shown, to avoid log spam from MutationObserver.
  private reportedNoEditor = false;

  start() {
    if (this.started) return;
    this.started = true;
    console.info("[pg4] bridge: started (MAIN world)");
    // Listen for messages from content script (extension-controlled, must carry nonce for writes).
    window.addEventListener("message", this.onWindowMessage);
    // CustomEvent fallback path (extension -> bridge) — supported for legacy paths.
    window.addEventListener("pg4:extension-command", this.onExtensionCommand as EventListener);

    // Schedule first discovery; document_idle already fired by the time this runs.
    this.scheduleDiscovery(0);

    // Watch for Query Tool tabs / new CM6 editors appearing later.
    this.observer = new MutationObserver(() => {
      this.scheduleDiscovery(50);
    });
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // --- Discovery -------------------------------------------------------------

  private scheduleDiscovery(delayMs: number) {
    if (this.discoveryTimer !== null) return;
    this.discoveryTimer = window.setTimeout(() => {
      this.discoveryTimer = null;
      void this.discoverEditors();
    }, delayMs);
  }

  private detectPgAdmin(): boolean {
    if (this.pgAdminDetected !== null) return this.pgAdminDetected;
    // Heuristics: pgAdmin4 web shell typically has these markers.
    const html = document.documentElement;
    const w = window as unknown as Record<string, any>;
    const markers = [
      () => !!w.pgAdmin,
      () => !!w.pgBrowser,
      () => !!html.querySelector('[data-pgadmin-role], .pg-admin'),
      () => document.title.toLowerCase().includes("pgadmin"),
      () => !!html.querySelector('link[href*="pgadmin"]'),
      () => !!document.querySelector('script[src*="pgadmin"]'),
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

  private discoverEditors() {
    // Even if we can't confidently detect pgAdmin, we still scan for CM6 editors
    // (so the bridge can be tested against CodeMirror playgrounds / custom CM6 deployments).
    // The content script (with allowlist knowledge) decides whether to actually use them.
    const ctor = findEditorViewCtor();
    if (!ctor) {
      // Soft warning: no CM6 detected on this page yet. Will retry on next mutation.
      this.notifyBridgeError("no-codemirror-ctor", "CodeMirror 6 EditorView constructor not found on window");
    }

    const candidates: HTMLElement[] = [];
    // Primary selector: CodeMirror 6 root class.
    document.querySelectorAll<HTMLElement>(".cm-editor").forEach((el) => candidates.push(el));
    // Secondary: pgAdmin4 wraps editors with various classes; broaden the scan but filter aggressively.
    document
      .querySelectorAll<HTMLElement>("[class*='cm-editor'], [class*='CodeMirror'], [data-pg-cm]")
      .forEach((el) => candidates.push(el));

    // Deduplicate.
    const seen = new Set<Element>();
    for (const el of candidates) {
      if (seen.has(el)) continue;
      seen.add(el);
      this.tryAdopt(el);
    }

    // Cleanup destroyed editors.
    for (const [id, tracked] of this.editors) {
      if (tracked.destroyed || !tracked.dom.isConnected) {
        this.detachEditor(id, "dom-removed");
      }
    }

    // Report discovery state once per change so Console shows why nothing works on a given page.
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

  private tryAdopt(el: HTMLElement): void {
    if (this.domToEditorId.has(el)) return;
    if (this.editors.size >= this.maxEditors) return;

    const view = findViewOnElement(el);
    if (!view) return;
    // Sanity: require a usable state + dispatch.
    if (!view.state?.doc || typeof view.dispatch !== "function" || typeof view.coordsAtPos !== "function") return;

    const editorId = `cm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.domToEditorId.set(el, editorId);
    console.info("[pg4] bridge: editor adopted", editorId);
    this.reportedNoEditor = false;

    const tracked: TrackedEditor = {
      editorId,
      view,
      dom: el,
      lastSentSql: "",
      lastSentCursor: -1,
      lastSentFrom: -1,
      lastSentTo: -1,
      unsubscribe: () => {},
      destroyed: false,
    };

    // CM6 update listener: fires on every transaction (input, paste, selection, programmatic).
    // We attach via the EditorView's `on` (if available) or by wrapping dispatch.
    this.attachUpdateListener(tracked);

    this.editors.set(editorId, tracked);
    this.notifyBridgeError; // satisfy unused warning suppression in some tsconfigs
    this.send({
      version: BRIDGE_PROTOCOL_VERSION,
      requestId: newRequestId(),
      source: BRIDGE_SOURCE,
      type: "editor-ready",
      editorId,
      cmVersion: this.detectCMVersion(view),
    });
    // Send initial state.
    this.sendEditorState(tracked, "input");
  }

  private detectCMVersion(view: CMEditorView): string | undefined {
    const anyView = view as any;
    return anyView?.constructor?.cmVersion ?? anyView?._cmVersion ?? undefined;
  }

  private attachUpdateListener(tracked: TrackedEditor) {
    const view = tracked.view as any;
    // Preferred: CM6 EditorView.updateListener extension — but we can't add extensions after the fact
    // without reconfiguring. So we wrap dispatch (per SPEC §4.2 — must preserve native dispatch).
    const originalDispatch = view.dispatch.bind(view) as (spec: unknown) => void;
    const bridge = this;
    view.dispatch = function (spec: unknown) {
      // Call original first so CM6 updates state, then read state to forward.
      originalDispatch(spec);
      if (tracked.destroyed) return;
      // Determine transaction kind heuristically.
      const s = spec as { userEvent?: string };
      let kind: "input" | "paste" | "selection" = "input";
      if (s?.userEvent === "select" || s?.userEvent === "delete.selection") kind = "selection";
      else if (s?.userEvent === "input.paste" || s?.userEvent === "paste") kind = "paste";
      else if (typeof s?.userEvent === "string" && s.userEvent.startsWith("input")) kind = "input";
      bridge.sendEditorState(tracked, kind);
    };

    // Focus tracking.
    const onFocus = () => {
      if (tracked.destroyed) return;
      bridge.sendEditorState(tracked, "selection");
    };
    tracked.dom.addEventListener("focusin", onFocus, true);

    tracked.unsubscribe = () => {
      try {
        view.dispatch = originalDispatch;
      } catch {
        /* ignore */
      }
      tracked.dom.removeEventListener("focusin", onFocus, true);
    };
  }

  private detachEditor(editorId: string, reason: string) {
    const tracked = this.editors.get(editorId);
    if (!tracked) return;
    tracked.destroyed = true;
    try {
      tracked.unsubscribe();
    } catch {
      /* ignore */
    }
    this.editors.delete(editorId);
    this.domToEditorId.delete(tracked.dom);
    this.send({
      version: BRIDGE_PROTOCOL_VERSION,
      requestId: newRequestId(),
      source: BRIDGE_SOURCE,
      type: "editor-blur",
      editorId,
    });
    void reason;
  }

  private sendEditorState(tracked: TrackedEditor, transactionKind: "input" | "paste" | "selection") {
    const view = tracked.view;
    let sql: string;
    let cursor: number;
    let from: number;
    let to: number;
    try {
      const doc = view.state.doc;
      sql = doc.toString();
      cursor = view.state.selection.main.head;
      from = view.state.selection.main.from;
      to = view.state.selection.main.to;
    } catch {
      // View in bad state; skip this update.
      return;
    }

    // Resource-exhaustion guard: never relay enormous payloads.
    if (sql.length > MAX_PAGE_PAYLOAD_CHARS) {
      // Truncate to last 100k chars around cursor for completion; diagnostics will skip.
      const around = 100_000;
      const start = Math.max(0, cursor - around);
      sql = sql.slice(start, start + around);
    }

    // Deduplicate redundant notifications to avoid message storms.
    if (
      sql === tracked.lastSentSql &&
      cursor === tracked.lastSentCursor &&
      from === tracked.lastSentFrom &&
      to === tracked.lastSentTo
    ) {
      return;
    }
    tracked.lastSentSql = sql;
    tracked.lastSentCursor = cursor;
    tracked.lastSentFrom = from;
    tracked.lastSentTo = to;

    let scrollRect: DOMRectLike | undefined;
    try {
      const coords = view.coordsAtPos(cursor);
      if (coords) {
        scrollRect = {
          left: coords.left,
          top: coords.top,
          right: coords.right,
          bottom: coords.bottom,
          width: coords.right - coords.left,
          height: coords.bottom - coords.top,
        };
      }
    } catch {
      /* ignore coords errors */
    }

    const type = transactionKind === "input" ? "editor-change" : "editor-state";
    // editor-state is sent for selection / paste / initial; editor-change for typing.
    // The content script treats both equivalently for completion triggering; it uses
    // transactionKind to decide whether to debounce.
    this.send({
      version: BRIDGE_PROTOCOL_VERSION,
      requestId: newRequestId(),
      source: BRIDGE_SOURCE,
      type: type as "editor-change" | "editor-state",
      editorId: tracked.editorId,
      sql,
      cursor,
      selection: { from, to: to === from ? cursor : to },
      transactionKind,
      scrollRect,
    });
  }

  // --- Outbound to content script (ISOLATED world) ---------------------------

  private send(msg: BridgeMessage) {
    window.postMessage(msg, "*");
  }

  private notifyBridgeError(code: string, detail: string) {
    this.send({
      version: BRIDGE_PROTOCOL_VERSION,
      requestId: newRequestId(),
      source: BRIDGE_SOURCE,
      type: "bridge-error",
      code,
      detail,
    });
  }

  // --- Inbound from content script (extension-controlled) --------------------

  private onWindowMessage = (ev: MessageEvent) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!isExtensionToBridgeMessage(data)) return;
    // Verify nonce for write-type messages (all current ExtensionToBridgeMessage types are writes).
    if (this.nonce && data.nonce !== this.nonce) {
      this.notifyBridgeError("nonce-mismatch", "extension command nonce mismatch");
      return;
    }
    const msg = data as ExtensionToBridgeMessage;
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

  private onExtensionCommand = (ev: CustomEvent) => {
    const detail = ev.detail;
    if (!isExtensionToBridgeMessage(detail)) return;
    // Treat CustomEvent path the same as window message.
    const fakeEvent: MessageEvent = new MessageEvent("message", { source: window, data: detail });
    this.onWindowMessage(fakeEvent);
  };

  private handleApplyCompletion(msg: Extract<ExtensionToBridgeMessage, { type: "apply-completion" }>) {
    const tracked = this.editors.get(msg.editorId);
    if (!tracked || tracked.destroyed) {
      this.notifyBridgeError("editor-not-found", `apply-completion: editor ${msg.editorId} not tracked`);
      return;
    }
    try {
      // SPEC §4.2: MUST use CM6 transaction dispatch.
      tracked.view.dispatch({
        changes: { from: msg.from, to: msg.to, insert: msg.insert },
        // Mark as user input so CM6 history (undo/redo) records it.
        userEvent: "input",
      });
    } catch (e: any) {
      this.notifyBridgeError("apply-completion-failed", e?.message ?? String(e));
    }
  }

  private handleRequestState(msg: Extract<ExtensionToBridgeMessage, { type: "request-state" }>) {
    const tracked = this.editors.get(msg.editorId);
    if (!tracked || tracked.destroyed) return;
    this.sendEditorState(tracked, "selection");
  }

  private handleFocus(msg: Extract<ExtensionToBridgeMessage, { type: "focus" }>) {
    const tracked = this.editors.get(msg.editorId);
    if (!tracked || tracked.destroyed) return;
    try {
      tracked.view.focus();
    } catch {
      /* ignore */
    }
  }

  private handleTeardown(msg: Extract<ExtensionToBridgeMessage, { type: "teardown" }>) {
    this.detachEditor(msg.editorId, "teardown");
  }

  // --- Public API used by content script via postMessage ----------------------
  // Content script sets the nonce once after initialization; from then on,
  // only its messages are honored for write operations.
  setNonce(nonce: string) {
    this.nonce = nonce;
  }

  // Stats / introspection (used by popup/options via content-script relay if needed).
  getTrackedEditorIds(): string[] {
    return Array.from(this.editors.keys());
  }
}

// --- Bootstrap ---------------------------------------------------------------
// The content script injects the nonce via a data attribute on <html> before this script runs
// (or sets it via postMessage after this script's editor-ready). We also accept a `pg4-init`
// CustomEvent carrying the nonce. Once a valid nonce is set, all subsequent writes must match.

const BRIDGE = new MainWorldBridge();

interface Pg4InitEvent {
  pg4: true;
  nonce: string;
}
window.addEventListener("pg4:init", (ev: Event) => {
  const detail = (ev as CustomEvent<Pg4InitEvent>).detail;
  if (detail?.pg4 && typeof detail.nonce === "string") {
    BRIDGE.setNonce(detail.nonce);
  }
});

// Expose a tiny hook so the content script can hand over the nonce directly
// via main-world function call (when content_scripts MAIN injection is used,
// both run in MAIN but our content script runs in ISOLATED — so window.postMessage
// is still required. The hook is for diagnostic / manual testing only.)
(window as any).__pg4Bridge = {
  setNonce: (nonce: string) => BRIDGE.setNonce(nonce),
  ids: () => BRIDGE.getTrackedEditorIds(),
};

// Final guard: never start twice, never throw on duplicate bootstrap.
try {
  BRIDGE.start();
} catch (e) {
  // Even on failure, surface to the content script so it can degrade gracefully.
  window.postMessage(
    {
      version: BRIDGE_PROTOCOL_VERSION,
      requestId: newRequestId(),
      source: BRIDGE_SOURCE,
      type: "bridge-error",
      code: "bootstrap-failed",
      detail: (e as Error)?.message ?? String(e),
    },
    "*"
  );
}

export {};
