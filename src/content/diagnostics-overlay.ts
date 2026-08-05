// Diagnostics overlay (SPEC §7.2).
// Renders an overlay of squiggle lines / error markers on top of the CodeMirror 6 editor DOM.
// We do NOT modify CM6 lint decorations or pgAdmin4's native decorations; we add a sibling
// absolutely-positioned canvas of <div class="pg4-diag"> markers positioned at character coords.
//
// We rely on the bridge's `coordsAtPos` (forwarded via editor-state messages with scrollRect)
// to position diagnostics. For simplicity we ask the bridge to compute coords for each diag.from.

import type { Diagnostic } from "../types/editor";
import type { DOMRectLike } from "../types/messages";
import { getShadow } from "./overlay-host";

export class DiagnosticsOverlay {
  private container: HTMLDivElement;
  private editorDom: HTMLElement | null;
  private diagnostics: Diagnostic[] = [];

  constructor(editorDom: HTMLElement | null) {
    const shadow = getShadow();
    this.container = document.createElement("div");
    this.container.className = "pg4-diagnostics-overlay";
    this.container.style.display = "none";
    this.editorDom = editorDom;
    shadow.appendChild(this.container);
  }

  /** Update the diagnostics display. coordsOf is a way to compute (left,top,right,bottom) for
   *  a given document offset, provided by the bridge. */
  async update(diagnostics: Diagnostic[], coordsOf: (offset: number) => DOMRectLike | null) {
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
        // Show inline detail
        const detail = document.createElement("div");
        detail.className = "pg4-diag-detail";
        detail.textContent = `${d.severity.toUpperCase()}: ${d.message}`;
        marker.appendChild(detail);
        setTimeout(() => detail.remove(), 4000);
      });
      this.container.appendChild(marker);
      drawn++;
      if (drawn >= 200) break; // cap markers for performance
    }
    this.container.style.display = drawn ? "block" : "none";
  }

  clear() {
    this.diagnostics = [];
    this.container.innerHTML = "";
    this.container.style.display = "none";
  }

  setEditorDom(dom: HTMLElement | null) {
    this.editorDom = dom;
  }

  destroy() {
    this.container.remove();
  }

  static injectStyles(shadow: ShadowRoot) {
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
      .pg4-diag-error::after { color: var(--pg4-error); content: "●"; }
      .pg4-diag-warning::after { color: var(--pg4-warn); content: "●"; }
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
}
