// Content script (SPEC §3.2, §6, §7, §9). Runs in ISOLATED world.
// Owns:
//   - Overlay host (shadow DOM)
//   - Worker client (parser-worker.js)
//   - Bridge message handling (window message events from MAIN-world bridge)
//   - Completion triggering, menu lifecycle, application
//   - Diagnostics debounce + overlay
//   - Hover doc card
//   - Smart paste
//   - Danger intercept on native execute buttons
//   - Usage + history recording
//
// NEVER persists page objects; NEVER overrides pgAdmin4 native behavior. On any error, degrades
// silently to the native editor (SPEC §2.1).

import {
  BRIDGE_PROTOCOL_VERSION,
  CONTENT_SOURCE,
  isBridgeMessage,
  newNonce,
  newRequestId,
  type BridgeMessage,
  type DOMRectLike,
  type ExtensionToBridgeMessage,
} from "../types/messages";

// Distributive Omit over a union of message variants (so per-variant fields survive).
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;
type BridgeCommand = DistributiveOmit<ExtensionToBridgeMessage, "version" | "source" | "nonce" | "requestId">;
import type { CompletionItem, EditorStateSnapshot } from "../types/completion";
import type { SchemaGraph } from "../types/schema-graph";
import { buildCompletionContext } from "../lib/context-parser";
import { quoteQualifiedIdentifier } from "../lib/sql-identifiers";
import type { Diagnostic, QueryHistoryEntry, Snippet, UsageStat } from "../types/editor";
import { WorkerRpcClient } from "../runtime/worker-rpc";
import { ensureOverlayHost, getShadow, onThemeChange } from "./overlay-host";
import { CompletionMenu } from "./completion-menu";
import { DangerDialog } from "./danger-dialog";
import { HoverCard } from "./hover-card";
import { DiagnosticsOverlay } from "./diagnostics-overlay";
import {
  getSettings,
  DEFAULT_SETTINGS,
  type Pg4Settings,
} from "../storage/chrome-storage";
import type { HoverDoc } from "../runtime/worker-rpc";

// ---------------------------------------------------------------------------
// Per-editor state
// ---------------------------------------------------------------------------

interface EditorSession {
  editorId: string;
  state: EditorStateSnapshot;
  scrollRect?: DOMRectLike;
  // editor DOM (discovered by matching the most recent ready state to a .cm-editor element)
  editorDom: HTMLElement | null;
  // open completion menu (if any)
  menu: CompletionMenu | null;
  // diagnostics overlay
  diagnostics: DiagnosticsOverlay;
  // hover card
  hover: HoverCard;
  // last completion request id (to drop stale responses)
  lastReqId: string | null;
  // debounce timers
  completionDebounce: number | null;
  diagnosticsDebounce: number | null;
  hoverDebounce: number | null;
}

interface PendingExplainExecution {
  editorId: string;
  expectedSql: string;
  target: HTMLElement;
  timeoutId: number;
}

// ---------------------------------------------------------------------------
// Content script singleton
// ---------------------------------------------------------------------------

class Pg4ContentScript {
  private nonce = newNonce();
  private sessions = new Map<string, EditorSession>();
  private activeEditorId: string | null = null;
  private worker: WorkerRpcClient | null = null;
  private settings: Pg4Settings = DEFAULT_SETTINGS;
  private activeGraph: SchemaGraph | null = null;
  private activeSnapshotId: string | null = null;
  private activeOrigin: string = location.origin;
  private hoverCard: HoverCard | null = null; // shared hover card (re-positioned per use)
  private globalDiagnostics: DiagnosticsOverlay | null = null;
  private initialized = false;
  private executeClickInterceptor: ((ev: Event) => void) | null = null;
  private pendingExplainExecution: PendingExplainExecution | null = null;

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    try {
      // 1. Overlay host (creates shadow DOM + injects theme variables).
      ensureOverlayHost();
      const shadow = getShadow();
      CompletionMenu.injectStyles(shadow);
      DangerDialog.injectStyles(shadow);
      HoverCard.injectStyles(shadow);
      DiagnosticsOverlay.injectStyles(shadow);
      this.hoverCard = new HoverCard();

      // 2. Load settings (chrome.storage.local). Stored via background.
      await this.reloadSettings();
      onThemeChange(() => {
        // force re-position of any open menu
        for (const s of this.sessions.values()) {
          if (s.menu) this.refreshMenu(s);
        }
      });

      // 3. Initialize parser worker (deferred — only created on first editor).
      this.worker = await this.createWorker();

      // 4. Load active snapshot for this origin from background.
      await this.reloadActiveSnapshot();

      // 5. Send nonce to bridge (MAIN world) via CustomEvent.
      this.handNonceToBridge();

      // 6. Listen for bridge messages (window message events).
      window.addEventListener("message", this.onBridgeMessage);

      // 7. Listen for chrome.runtime messages from background (settings / snapshot changes).
      chrome.runtime.onMessage.addListener(this.onBackgroundMessage);

      // 8. Listen for execute button clicks (danger intercept).
      this.attachExecuteInterceptor();

      // 9. Listen for paste events for smart paste wrapping.
      document.addEventListener("paste", this.onPaste, true);

      // 9b. Forced completion trigger (Ctrl+Space / Cmd+Space).
      document.addEventListener("keydown", this.onForceShortcut, true);

      // 10. Cleanup on unload.
      window.addEventListener("pagehide", this.cleanup);
      window.addEventListener("beforeunload", this.cleanup);
    } catch (e) {
      // Silent degradation: log to console for diagnostics.
      console.warn("[pg4] content script init failed (pgAdmin4 will continue normally):", e);
    }
  }

  // --- Worker setup ---------------------------------------------------------

  private async createWorker(): Promise<WorkerRpcClient | null> {
    try {
      const url = chrome.runtime.getURL("parser-worker.js");
      // MV3: content scripts can't construct a Worker from a chrome-extension:// URL
      // (cross-origin Worker construction is blocked). If that throws, fetch the source
      // and build a same-origin blob URL worker instead.
      let w: Worker;
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
      // Set initial config.
      void client.call("set-config", { maxCandidates: this.settings.maxCandidates, showSystemTables: this.settings.showSystemTables });
      return client;
    } catch (e) {
      console.warn("[pg4] worker creation failed:", e);
      return null;
    }
  }

  // --- Bridge communication -------------------------------------------------

  private handNonceToBridge() {
    // Try CustomEvent (preferred — detail is structured-cloned).
    try {
      window.dispatchEvent(
        new CustomEvent("pg4:init", { detail: { pg4: true, nonce: this.nonce } })
      );
    } catch {
      /* ignore */
    }
    // Also set a data attribute as fallback for very late bridge boots.
    document.documentElement.setAttribute("data-pg4-nonce", this.nonce);
  }

  private sendToBridge(msg: BridgeCommand) {
    const full: ExtensionToBridgeMessage = {
      version: BRIDGE_PROTOCOL_VERSION,
      requestId: newRequestId(),
      source: CONTENT_SOURCE,
      nonce: this.nonce,
      ...msg,
    } as ExtensionToBridgeMessage;
    window.postMessage(full, "*");
  }

  private onBridgeMessage = async (ev: MessageEvent) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!isBridgeMessage(data)) return;
    const msg = data as BridgeMessage;
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

  private async onEditorReady(editorId: string) {
    if (this.sessions.has(editorId)) {
      // Already tracking — request fresh state.
      this.sendToBridge({ type: "request-state", editorId });
      return;
    }
    const editorDom = this.findEditorDomFor(editorId);
    const diagnostics = new DiagnosticsOverlay(editorDom);
    // Reuse the shared hover card instance (created in init). Previously each
    // session created its own HoverCard, but scheduleHover showed on the shared
    // instance while hide() was called on the per-session instance — leaving the
    // card stuck on screen. Pointing session.hover at the shared instance fixes it.
    const hover = this.hoverCard ?? new HoverCard();
    const session: EditorSession = {
      editorId,
      state: { editorId, sql: "", cursor: 0, selection: { from: 0, to: 0 } },
      editorDom,
      menu: null,
      diagnostics,
      hover,
      lastReqId: null,
      completionDebounce: null,
      diagnosticsDebounce: null,
      hoverDebounce: null,
    };
    this.sessions.set(editorId, session);
    this.activeEditorId = editorId;
    // Ask bridge for current state.
    this.sendToBridge({ type: "request-state", editorId });
    // Push active graph + usage + snippets + config to worker (worker is per-content-script).
    await this.syncWorkerState();
    // Re-attach diagnostics editor DOM if it was found later.
    setTimeout(() => {
      if (!session.editorDom) {
        session.editorDom = this.findEditorDomFor(editorId);
        session.diagnostics.setEditorDom(session.editorDom);
      }
    }, 250);
  }

  private findEditorDomFor(_editorId: string): HTMLElement | null {
    // Bridge doesn't tell us which DOM node corresponds to the editorId; we use a heuristic:
    // the most recently-focused .cm-editor element. For multi-editor pgAdmin4 windows this is
    // imperfect; Phase 0 probe will refine. For now, take the focused one if any, else the first.
    const editors = Array.from(document.querySelectorAll<HTMLElement>(".cm-editor"));
    const focused = editors.find((el) => el === document.activeElement || el.contains(document.activeElement));
    return focused ?? editors[0] ?? null;
  }

  private async onEditorState(
    editorId: string,
    sql: string,
    cursor: number,
    selection: { from: number; to: number },
    scrollRect: DOMRectLike | undefined,
    kind: "input" | "paste" | "selection"
  ) {
    const session = this.sessions.get(editorId);
    if (!session) {
      // Editor was discovered but we missed the ready event — re-track.
      await this.onEditorReady(editorId);
    }
    const s = this.sessions.get(editorId);
    if (!s) return;
    s.state = { editorId, sql, cursor, selection: { from: selection.from, to: selection.to } };
    s.scrollRect = scrollRect as DOMRectLike | undefined;
    this.activeEditorId = editorId;
    this.executePendingExplain(editorId, sql);

    // Trigger completion (debounced).
    if (kind === "input" || kind === "paste") {
      // Typing dismisses any open hover card immediately — the user is no longer
      // "hovering" to read docs, so a lingering card would obstruct the editor.
      if (kind === "input") this.hoverCard?.hide();
      // Close the menu immediately when the just-typed character collapses the
      // prefix (a space or other non-identifier char). This avoids the 30ms
      // debounce window during which a fast Tab would commit at a stale range.
      if (s.menu) {
        const ch = sql[cursor - 1];
        if (ch && !/[A-Za-z0-9_]/.test(ch) && !isImmediateTriggerContext(sql, cursor)) {
          this.closeMenu(s, "external");
        }
      }
      this.scheduleCompletion(s, kind);
    } else if (kind === "selection") {
      // Selection change: don't auto-trigger; but if menu is open, keep its range in sync.
      if (s.menu) {
        // Close menu on cursor move beyond the original trigger range.
        // (Keep it simple — close on selection change.)
        this.closeMenu(s, "blur");
      }
    }

    // Schedule diagnostics (300ms debounce).
    if (this.settings.diagnosticsEnabled) {
      this.scheduleDiagnostics(s);
    }

    // Schedule hover on token under cursor (only if selection is collapsed).
    if (selection.from === selection.to) {
      this.scheduleHover(s);
    }
  }

  private onEditorBlur(editorId: string) {
    const s = this.sessions.get(editorId);
    if (!s) return;
    this.closeMenu(s, "blur");
    s.hover.hide();
    s.diagnostics.clear();
  }

  private async onExecutingQuery(editorId: string, sql: string) {
    // SPEC §9.2: record query history only on user-initiated execution.
    const s = this.sessions.get(editorId);
    if (!s) return;
    const entry: Omit<QueryHistoryEntry, "id"> = {
      sql,
      executedAt: Date.now(),
      snapshotId: this.activeSnapshotId,
      origin: this.activeOrigin,
    };
    try {
      // Send to background for IndexedDB write (content scripts CAN access IndexedDB directly,
      // but background keeps a single source of truth for history across tabs).
      await chrome.runtime.sendMessage({ type: "pg4:add-history", entry });
    } catch {
      /* ignore — non-fatal */
    }
  }

  // --- Completion -----------------------------------------------------------

  private scheduleCompletion(session: EditorSession, _kind: "input" | "paste") {
    if (session.completionDebounce !== null) {
      clearTimeout(session.completionDebounce);
    }
    const sql = session.state.sql;
    const cursor = session.state.cursor;
    // SPEC §6.6: auto-trigger after 2 chars, immediate on `.`/`->` etc.
    const trigger = computeTrigger(sql, cursor);
    const delay = trigger.immediate ? 0 : 30; // small debounce for typing
    session.completionDebounce = window.setTimeout(() => {
      session.completionDebounce = null;
      void this.requestCompletion(session, sql, cursor, trigger.force);
    }, delay);
  }

  private async requestCompletion(session: EditorSession, sql: string, cursor: number, force: boolean) {
    if (!this.worker) return;
    if (this.settings.completionTriggerMode === "manual" && !force) {
      if (session.menu) this.closeMenu(session, "external");
      return;
    }
    // Check trigger conditions.
    if (!force) {
      const prefix = currentPrefix(sql, cursor);
      const context = buildCompletionContext({ sql, cursor, graph: this.activeGraph });
      const canShowEmptyColumnList = context.kind === "column" || context.kind === "qualified-column";
      const canShowSingleKeyword = context.kind === "keyword" && prefix.length > 0;
      if (prefix.length < 2 && !isImmediateTriggerContext(sql, cursor) && !canShowEmptyColumnList && !canShowSingleKeyword) {
        // Prefix collapsed (e.g. user typed a space or moved past the token). Close
        // any open menu so a subsequent Tab/Enter cannot commit at a stale
        // replaceRange — this is the root cause of "completion inserted at the
        // original cursor position after pressing space".
        if (session.menu) this.closeMenu(session, "external");
        return;
      }
    }
    const reqId = newRequestId();
    session.lastReqId = reqId;
    try {
      const result = await this.worker.call("complete", {
        sql,
        cursor,
        editorId: session.editorId,
      });
      // Drop stale responses.
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
    void this.requestCompletion(s, s.state.sql, s.state.cursor, /* force */ true);
  }

  private showOrUpdateMenu(session: EditorSession, items: CompletionItem[], from: number, to: number) {
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
        onCancel: () => this.closeMenu(session, "external"),
      });
    }
  }

  private anchorForCursor(session: EditorSession): { left: number; top: number; bottom: number } | null {
    const rect = session.scrollRect;
    if (rect) {
      return { left: rect.left, top: rect.top, bottom: rect.bottom };
    }
    // Fallback: try the editor DOM rect.
    if (session.editorDom) {
      const r = session.editorDom.getBoundingClientRect();
      return { left: r.left + 8, top: r.top + 8, bottom: r.top + 32 };
    }
    return null;
  }

  private applyCompletion(session: EditorSession, item: CompletionItem, range: { from: number; to: number }) {
    // SPEC §6.6: replace [from, to) via CodeMirror transaction.
    const insertText = item.kind === "table" || item.kind === "view"
      ? quoteQualifiedIdentifier(item.insertText)
      : item.insertText;
    this.sendToBridge({
      type: "apply-completion",
      editorId: session.editorId,
      from: range.from,
      to: range.to,
      insert: insertText,
    });
    // Record usage locally (worker increments per-session counter).
    if (this.worker) {
      // Heuristic: use label as symbolKey (worker does its own normalization).
      const symbolKey = item.detail ?? item.label;
      void this.worker.call("record-usage", { symbolKey });
      // Persist to background (frequency table).
      if (this.activeSnapshotId) {
        try {
          void chrome.runtime.sendMessage({
            type: "pg4:record-usage",
            symbolKey,
            snapshotId: this.activeSnapshotId,
          });
        } catch {
          /* ignore */
        }
      }
    }
    this.closeMenu(session, "external");
  }

  private closeMenu(session: EditorSession, reason: "escape" | "blur" | "outside-click" | "external") {
    if (!session.menu) return;
    session.menu.destroy(reason);
    session.menu = null;
  }

  private refreshMenu(session: EditorSession) {
    if (!session.menu) return;
    const anchor = this.anchorForCursor(session);
    if (anchor) session.menu.position(anchor);
  }

  // --- Diagnostics ----------------------------------------------------------

  private scheduleDiagnostics(session: EditorSession) {
    if (session.diagnosticsDebounce !== null) clearTimeout(session.diagnosticsDebounce);
    const sql = session.state.sql;
    const cursor = session.state.cursor;
    session.diagnosticsDebounce = window.setTimeout(async () => {
      session.diagnosticsDebounce = null;
      if (!this.worker) return;
      try {
        const result = await this.worker.call("diagnose", { sql, cursor });
        // Render overlay.
        const coordsOf = (offset: number): DOMRectLike | null => {
          // We don't have coordsAtPos per offset synchronously; for the initial implementation
          // we approximate using scrollRect at the cursor location. A future probe should add a
          // bridge method `coords-at-offset` (SPEC §4.3).
          void offset;
          return session.scrollRect ?? null;
        };
        await session.diagnostics.update(result.diagnostics, coordsOf);
      } catch (e) {
        console.debug("[pg4] diagnostics failed:", e);
      }
    }, 300);
  }

  // --- Hover ----------------------------------------------------------------

  private scheduleHover(session: EditorSession) {
    if (session.hoverDebounce !== null) clearTimeout(session.hoverDebounce);
    const sql = session.state.sql;
    const cursor = session.state.cursor;
    session.hoverDebounce = window.setTimeout(async () => {
      session.hoverDebounce = null;
      if (!this.worker) return;
      // Find token under cursor.
      const token = tokenAtCursor(sql, cursor);
      if (!token) {
        session.hover.hide();
        return;
      }
      try {
        const result = await this.worker.call("resolve-hover", { symbol: token, sql, cursor });
        if (result.documentation && session.scrollRect && this.hoverCard) {
          const r = session.scrollRect;
          this.hoverCard.show(result.documentation as HoverDoc, {
            left: r.left,
            top: r.top,
            bottom: r.bottom,
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

  private onPaste = async (ev: ClipboardEvent) => {
    if (this.settings.pasteMode === "off") return;
    if (!ev.clipboardData) return;
    const text = ev.clipboardData.getData("text/plain");
    if (!text) return;
    // Conditions: no newlines, ≤256 chars, no quotes.
    if (text.includes("\n") || text.length > 256) return;
    if (text.includes("'") || text.includes('"')) return;

    const editorId = this.activeEditorId;
    if (!editorId) return;
    const session = this.sessions.get(editorId);
    if (!session) return;
    // Determine context: identifier slot vs string-literal slot.
    const sql = session.state.sql;
    const cursor = session.state.cursor;
    const ctx = classifyPasteContext(sql, cursor);
    if (!ctx.wrap) return;
    // We don't intercept the paste itself; we replace the inserted text via CM6 transaction.
    // Strategy: preventDefault and apply our own insertion with proper escaping.
    ev.preventDefault();
    ev.stopPropagation();
    const wrapped = wrapPaste(text, ctx);
    // Insert at cursor via bridge (apply-completion with from=to=cursor).
    this.sendToBridge({
      type: "apply-completion",
      editorId,
      from: cursor,
      to: cursor,
      insert: wrapped,
    });
    // First-run hint (deferred — non-fatal).
    if (!this.settings.smartPasteHintDismissed && this.settings.pasteMode === "on") {
      this.showSmartPasteHintOnce();
    }
  };

  private smartPasteHintShown = false;
  private showSmartPasteHintOnce() {
    if (this.smartPasteHintShown) return;
    this.smartPasteHintShown = true;
    // Minimal toast — non-blocking.
    const shadow = getShadow();
    const toast = document.createElement("div");
    toast.className = "pg4-toast";
    toast.textContent = "PG4 wrapped your paste with quotes. Disable in extension options.";
    toast.style.cssText =
      "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--pg4-bg);color:var(--pg4-fg);border:1px solid var(--pg4-border);border-radius:6px;padding:8px 12px;font-size:12px;font-family:var(--pg4-font);box-shadow:var(--pg4-shadow);z-index:2147483647;pointer-events:auto;";
    shadow.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // --- Danger intercept (SPEC §9.3) -----------------------------------------

  private attachExecuteInterceptor() {
    // Heuristic: pgAdmin4's Query Tool execute button.
    // We listen at capture phase so we can show the confirmation dialog before pgAdmin4's own
    // click handler runs. If the user cancels, we stopPropagation; if they proceed, we re-dispatch
    // a synthetic click on the same target.
    const selectors = [
      'button[aria-label*="Execute" i]',
      'button[aria-label*="Run" i]',
      'button[title*="Execute" i]',
      'button[title*="Run" i]',
      'button[data-action="execute-query"]',
      'a[data-action="execute-query"]',
      '.pg4-execute-button',
    ];
    const getExecuteControl = (el: Element | null): HTMLElement | null => {
      if (!el) return null;
      for (const sel of selectors) {
        try {
          const match = el.matches?.(sel) ? el : el.closest?.(sel);
          if (match instanceof HTMLElement) return match;
        } catch {
          continue;
        }
      }
      return null;
    };
    this.executeClickInterceptor = (ev: Event) => {
      if (!this.settings.dangerInterceptEnabled) return;
      const target = ev.target as Element | null;
      const executeControl = getExecuteControl(target);
      if (!executeControl) return;
      const session = this.activeEditorId ? this.sessions.get(this.activeEditorId) : null;
      if (!session) return;
      const sql = session.state.sql;
      if (!sql.trim()) return;
      // Synchronous detection (worker call is async; we use a sync fallback heuristic).
      const danger = quickDetectDangerSync(sql);
      if (!danger.detected) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      // Show dialog.
      const dialog = new DangerDialog({
        sql,
        result: danger,
        canExplain: canExplainStatement(sql),
        onConfirm: (mode) => {
          if (mode === "explain") {
            this.executeExplain(session, sql, executeControl);
          } else {
            // Re-dispatch the click on the original target.
            // Use a slight delay so our dialog cleanup finishes first.
            setTimeout(() => {
              executeControl.click();
            }, 0);
          }
        },
        onCancel: () => {
          /* SPEC §9.3.2: do not swallow subsequent events. */
        },
      });
      void dialog;
    };
    document.addEventListener("click", this.executeClickInterceptor, /* capture */ true);
  }

  private executeExplain(session: EditorSession, sql: string, target: HTMLElement) {
    const explain = `EXPLAIN ${sql.trim()}`;
    this.cancelPendingExplain();
    const timeoutId = window.setTimeout(() => {
      this.pendingExplainExecution = null;
      this.showDangerToast("Unable to prepare EXPLAIN. The original statement was not executed.");
    }, 1_000);
    this.pendingExplainExecution = {
      editorId: session.editorId,
      expectedSql: explain,
      target,
      timeoutId,
    };
    this.sendToBridge({
      type: "apply-completion",
      editorId: session.editorId,
      from: 0,
      to: sql.length,
      insert: explain,
    });
  }

  private executePendingExplain(editorId: string, sql: string) {
    const pending = this.pendingExplainExecution;
    if (!pending || pending.editorId !== editorId || pending.expectedSql !== sql) return;
    this.pendingExplainExecution = null;
    clearTimeout(pending.timeoutId);
    if (!pending.target.isConnected) {
      this.showDangerToast("Unable to run EXPLAIN because the execute control is no longer available.");
      return;
    }
    pending.target.click();
  }

  private cancelPendingExplain() {
    if (!this.pendingExplainExecution) return;
    clearTimeout(this.pendingExplainExecution.timeoutId);
    this.pendingExplainExecution = null;
  }

  private showDangerToast(message: string) {
    const toast = document.createElement("div");
    toast.textContent = message;
    toast.style.cssText =
      "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--pg4-bg);color:var(--pg4-fg);border:1px solid var(--pg4-border);border-radius:6px;padding:8px 12px;font-size:12px;font-family:var(--pg4-font);box-shadow:var(--pg4-shadow);z-index:2147483647;pointer-events:auto;";
    getShadow().appendChild(toast);
    setTimeout(() => toast.remove(), 4_000);
  }

  // --- Background communication ---------------------------------------------

  private onBackgroundMessage = (msg: unknown, _sender: chrome.runtime.MessageSender, _sendResponse: (v?: unknown) => void) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { type?: string };
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

  private async reloadSettings() {
    try {
      this.settings = await getSettings();
    } catch {
      this.settings = DEFAULT_SETTINGS;
    }
    if (this.worker) {
      void this.worker.call("set-config", { maxCandidates: this.settings.maxCandidates, showSystemTables: this.settings.showSystemTables });
    }
  }

  private async reloadSnippets() {
    if (!this.worker) return;
    try {
      const snippets = (await chrome.runtime.sendMessage({ type: "pg4:list-snippets" })) as Snippet[] | null;
      if (snippets) void this.worker.call("set-snippets", { snippets });
    } catch {
      /* ignore */
    }
  }

  private async reloadActiveSnapshot() {
    // Ask background for the active graph + usage + snippets for this origin.
    try {
      const resp = (await chrome.runtime.sendMessage({
        type: "pg4:get-active-context",
        origin: this.activeOrigin,
      })) as {
        snapshotId: string | null;
        graph: SchemaGraph | null;
        usage: UsageStat[];
        snippets: Snippet[];
      } | null;
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
        snippets: resp.snippets.length,
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

  private async syncWorkerState() {
    if (!this.worker) return;
    await this.worker.call("set-active-graph", { graph: this.activeGraph });
    await this.worker.call("set-config", { maxCandidates: this.settings.maxCandidates, showSystemTables: this.settings.showSystemTables });
  }

  // --- Forced completion shortcut ------------------------------------------

  private onForceShortcut = (ev: KeyboardEvent) => {
    // Ctrl+Space or Cmd+Space. We allow the user to remap via settings.completionShortcut
    // (supported format: "Ctrl+Space" / "Cmd+Space" / "Alt+/"). Parsing is minimal.
    const want = this.settings.completionShortcut || "Ctrl+Space";
    const parts = want.toLowerCase().split("+").map((s) => s.trim());
    const needCtrl = parts.includes("ctrl");
    const needCmd = parts.includes("cmd") || parts.includes("meta");
    const needAlt = parts.includes("alt");
    const needShift = parts.includes("shift");
    const key = parts[parts.length - 1] ?? "space";
    const code = key === "space" ? " " : key;
    if (ev.ctrlKey !== needCtrl) return;
    if ((ev.metaKey !== needCmd) && needCmd) return;
    if (ev.altKey !== needAlt) return;
    if (ev.shiftKey !== needShift) return;
    if (ev.key.toLowerCase() !== code.toLowerCase() && ev.code.toLowerCase() !== `key${code}`.toLowerCase()) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.forceTriggerCompletion();
  };

  // --- Cleanup --------------------------------------------------------------

  private cleanup = () => {
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
      this.cancelPendingExplain();
      this.hoverCard?.destroy();
    } catch {
      /* ignore */
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TriggerInfo {
  /** true if context implies immediate trigger (e.g. `.` or `->` before cursor). */
  immediate: boolean;
  /** true if forced (Ctrl+Space). Set externally; here always false. */
  force: boolean;
}

function computeTrigger(sql: string, cursor: number): TriggerInfo {
  return { immediate: isImmediateTriggerContext(sql, cursor), force: false };
}

function currentPrefix(sql: string, cursor: number): string {
  // Walk back from cursor over identifier chars.
  let i = cursor;
  while (i > 0) {
    const ch = sql[i - 1]!;
    if (/[A-Za-z0-9_]/.test(ch)) {
      i--;
      continue;
    }
    break;
  }
  return sql.slice(i, cursor);
}

function isImmediateTriggerContext(sql: string, cursor: number): boolean {
  // Check for `.` or `->` / `->>` / `#>` / `#>>` before cursor.
  const before = sql.slice(Math.max(0, cursor - 3), cursor);
  return /(\.|->>|->|#>>|#>)$/.test(before);
}

function tokenAtCursor(sql: string, cursor: number): string | null {
  // Find the identifier (possibly dotted) around the cursor.
  let start = cursor;
  let end = cursor;
  while (start > 0 && /[A-Za-z0-9_.]/.test(sql[start - 1]!)) start--;
  while (end < sql.length && /[A-Za-z0-9_.]/.test(sql[end]!)) end++;
  if (start === end) return null;
  return sql.slice(start, end);
}

type PasteContext = { wrap: false } | { wrap: true; kind: "string" | "identifier" };

function classifyPasteContext(sql: string, cursor: number): PasteContext {
  // Look back a few chars before the cursor to guess whether this is a string-literal slot.
  const before = sql.slice(Math.max(0, cursor - 32), cursor).trimEnd();
  if (/=\s*$/.test(before) || /VALUES\s*\(/i.test(before) || /IN\s*\(/i.test(before)) {
    return { wrap: true, kind: "string" };
  }
  // Identifier slot: SELECT <cursor> or after a comma in a select list.
  if (/(SELECT|SELECT DISTINCT)\s+$/i.test(before) || /,\s*$/i.test(before)) {
    return { wrap: true, kind: "identifier" };
  }
  return { wrap: false };
}

function wrapPaste(text: string, ctx: PasteContext): string {
  if (!ctx.wrap) return text;
  if (ctx.kind === "string") {
    return `'${text.replace(/'/g, "''")}'`;
  }
  // identifier wrap: only when needed.
  if (/[A-Z]/.test(text) || /\s/.test(text) || /[^A-Za-z0-9_]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function quickDetectDangerSync(sql: string): { detected: boolean; kind: string | null; reasons: string[]; targetObjects: string[] } {
  const reasons: string[] = [];
  const targetObjects: string[] = [];
  let kind: string | null = null;
  const upper = sql.toUpperCase();
  const noComment = sql.replace(/--[^\n]*\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, " ");
  const stmt = noComment.trim();
  const stmtUpper = stmt.toUpperCase();

  // DELETE / UPDATE without WHERE.
  if (/^\s*DELETE\s+FROM\b/i.test(stmt) || /^\s*DELETE\b/i.test(stmt)) {
    if (!/\bWHERE\b/i.test(stmt)) {
      kind = "DELETE without WHERE";
      reasons.push("DELETE statement has no WHERE clause — affects all rows.");
      const m = stmt.match(/DELETE\s+FROM\s+([A-Za-z_][\w.]*)/i);
      if (m) targetObjects.push(m[1]!);
    } else if (/\bWHERE\s+(1\s*=\s*1|TRUE\s*\b|'x'\s*=\s*'x'\b|0\s*=\s*0\b)/i.test(stmt)) {
      kind = "DELETE with tautology WHERE";
      reasons.push("WHERE clause appears to always be true — affects all rows.");
    }
  }
  if (/^\s*UPDATE\b/i.test(stmt)) {
    if (!/\bWHERE\b/i.test(stmt)) {
      kind = "UPDATE without WHERE";
      reasons.push("UPDATE statement has no WHERE clause — affects all rows.");
      const m = stmt.match(/UPDATE\s+([A-Za-z_][\w.]*)/i);
      if (m) targetObjects.push(m[1]!);
    }
  }
  if (/^\s*TRUNCATE\b/i.test(stmt)) {
    kind = "TRUNCATE";
    reasons.push("TRUNCATE removes all rows quickly without per-row logging.");
    const m = stmt.match(/TRUNCATE\s+(?:TABLE\s+)?([A-Za-z_][\w.]*)/i);
    if (m) targetObjects.push(m[1]!);
  }
  if (/^\s*DROP\s+(TABLE|SCHEMA|DATABASE)\b/i.test(stmt)) {
    const m = stmt.match(/DROP\s+(TABLE|SCHEMA|DATABASE)\s+([A-Za-z_][\w.]*)/i);
    kind = m ? `DROP ${m[1]}` : "DROP";
    reasons.push(`DROP ${m?.[1] ?? "object"} permanently removes the object.`);
    if (m) targetObjects.push(m[2]!);
  }
  if (/ALTER\s+TABLE\b/i.test(stmtUpper) && /DROP\s+COLUMN\b/i.test(stmtUpper)) {
    kind = "ALTER TABLE DROP COLUMN";
    reasons.push("Dropping a column is destructive and not reversible without backup.");
    const m = stmt.match(/ALTER\s+TABLE\s+([A-Za-z_][\w.]*)/i);
    if (m) targetObjects.push(m[1]!);
  }
  void upper;
  return { detected: !!kind, kind, reasons, targetObjects };
}

function canExplainStatement(sql: string): boolean {
  return /^\s*(?:DELETE|UPDATE)\b/i.test(sql);
}

// ---------------------------------------------------------------------------
// Bootstrap (only on origins that look like pgAdmin4 — actual origin allowlist is enforced
// by content_scripts matches in manifest.json, plus optional host permissions granted by user).
// ---------------------------------------------------------------------------

const cs = new Pg4ContentScript();
void cs.init();

// Export nothing — content script is a top-level IIFE bundle.
export {};
