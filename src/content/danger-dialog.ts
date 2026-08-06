// Danger confirmation dialog (SPEC §9.3).
// Intercepts native pgAdmin4 execute clicks; shows a second-confirm layer with statement category,
// target objects, and risk reasons. The user can cancel (restores normal editor focus) or proceed.
//
// SPEC §9.3 interaction rules:
//   1. Show second-confirm before native execute.
//   2. Cancel must NOT swallow subsequent editor events.
//   3. "EXPLAIN estimate" only via pgAdmin4's existing channel (we don't run SQL ourselves).
//   4. If EXPLAIN/DDL/version-incompatible: show "cannot estimate".
//   5. On confirm we only re-dispatch the original user click, never construct DML/DDL ourselves.

export interface DangerResult {
  detected: boolean;
  kind: string | null;
  reasons: string[];
  targetObjects: string[];
}

export interface DangerDialogOptions {
  /** SQL that triggered the dialog (truncated for display). */
  sql: string;
  result: DangerResult;
  /** Whether EXPLAIN can estimate this statement without executing it. */
  canExplain: boolean;
  /** Called when user confirms; the caller is responsible for re-dispatching the original click. */
  onConfirm: (mode: "execute" | "explain") => void;
  /** Called when user cancels. */
  onCancel: () => void;
}

export class DangerDialog {
  private container: HTMLDivElement;
  private cancelled = false;
  private keydownHandler: (ev: KeyboardEvent) => void;
  private outsideClickHandler: (ev: MouseEvent) => void;

  constructor(opts: DangerDialogOptions) {
    const shadow = (document.getElementById("pg4-overlay-root") as HTMLDivElement)?.shadowRoot;
    if (!shadow) {
      // No overlay host — fall back to immediate cancel.
      opts.onCancel();
      this.container = null as unknown as HTMLDivElement;
      this.keydownHandler = () => {};
      this.outsideClickHandler = () => {};
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

    const targets = opts.result.targetObjects.length
      ? (() => {
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
        })()
      : null;

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

    const explain = opts.canExplain
      ? (() => {
          const button = document.createElement("button");
          button.className = "pg4-btn pg4-btn-explain";
          button.textContent = "EXPLAIN estimate";
          button.title = "Run EXPLAIN <statement> through pgAdmin4's existing query channel";
          button.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this.close("explain", opts);
          });
          return button;
        })()
      : null;

    const proceed = document.createElement("button");
    proceed.className = "pg4-btn pg4-btn-proceed";
    proceed.textContent = "Proceed anyway";
    proceed.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.close("execute", opts);
    });

    actions.appendChild(cancel);
    if (explain) actions.appendChild(explain);
    actions.appendChild(proceed);

    this.container.appendChild(title);
    if (reasons.childNodes.length) this.container.appendChild(reasons);
    if (targets) this.container.appendChild(targets);
    if (!opts.canExplain) {
      const unavailable = document.createElement("div");
      unavailable.className = "pg4-danger-unavailable";
      unavailable.textContent = "Estimate unavailable for this statement type.";
      this.container.appendChild(unavailable);
    }
    this.container.appendChild(sqlBox);
    this.container.appendChild(actions);

    shadow.appendChild(this.container);

    this.keydownHandler = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        this.close("cancel", opts);
      } else if (ev.key === "Enter") {
        // Default to cancel on plain Enter — safer.
        ev.preventDefault();
        ev.stopPropagation();
        this.close("cancel", opts);
      }
    };
    this.outsideClickHandler = (ev) => {
      // Block outside interactions while modal is up.
      const target = ev.target as Node | null;
      if (target && this.container.contains(target)) return;
      ev.preventDefault();
      ev.stopPropagation();
    };
    document.addEventListener("keydown", this.keydownHandler, true);
    // Capture-phase mousedown to absorb clicks outside the dialog.
    document.addEventListener("mousedown", this.outsideClickHandler, true);
    // Focus the cancel button so keyboard works immediately.
    setTimeout(() => cancel.focus(), 0);
  }

  private close(mode: "cancel" | "execute" | "explain", opts: DangerDialogOptions) {
    if (this.cancelled) return;
    this.cancelled = true;
    document.removeEventListener("keydown", this.keydownHandler, true);
    document.removeEventListener("mousedown", this.outsideClickHandler, true);
    if (this.container) this.container.remove();
    if (mode === "cancel") opts.onCancel();
    else opts.onConfirm(mode);
  }

  static injectStyles(shadow: ShadowRoot) {
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
      .pg4-danger-unavailable {
        font-size: 12px;
        color: var(--pg4-muted);
        margin: 0 0 8px;
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
}

function truncateSql(sql: string): string {
  const max = 1200;
  if (sql.length <= max) return sql;
  return sql.slice(0, max) + "\n…[truncated]";
}
