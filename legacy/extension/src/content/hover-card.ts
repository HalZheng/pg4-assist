// Object hover documentation card (SPEC §7.3).
// Shows qualified name, type, nullability, default, comment, PK/FK relationships and JSONB root
// count. 350ms hover delay before showing; 150ms leave delay before hiding.
// Floating layer must support keyboard close and restore editor focus.

import type { HoverDoc } from "../runtime/worker-rpc";
import { getShadow } from "./overlay-host";

export class HoverCard {
  private container: HTMLDivElement;
  private hideTimer: number | null = null;
  private keydownHandler: (ev: KeyboardEvent) => void;

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
  show(doc: HoverDoc, anchor: { left: number; top: number; bottom: number }) {
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
    if (doc.nullable !== undefined) {
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
    if (doc.jsonbRootCount !== undefined && doc.jsonbRootCount > 0) {
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

    // Position below the anchor, flip if no room.
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
      // flip above
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

  static injectStyles(shadow: ShadowRoot) {
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
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
