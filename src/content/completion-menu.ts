// Completion menu overlay (SPEC §6.6, §10).
// Renders into the shared Shadow DOM host. ARIA combobox/listbox semantics, keyboard navigation
// (ArrowUp/Down/PageUp/PageDown/Home/End/Enter/Tab/Escape), mouse hover/click selection.
// The menu itself is keyboard-trapped only while visible; Escape restores editor focus.

import type { CompletionItem } from "../types/completion";
import { getShadow, getTheme } from "./overlay-host";

export interface CompletionMenuOptions {
  /** editor coords where the menu should anchor */
  anchor: { left: number; top: number; bottom: number };
  items: CompletionItem[];
  /** range in the editor to replace when an item is selected */
  replaceRange: { from: number; to: number };
  /** initial selected index */
  initialIndex?: number;
  /** called when user selects an item */
  onSelect: (item: CompletionItem, replaceRange: { from: number; to: number }) => void;
  /** called when user cancels (Escape or blur) */
  onCancel: (reason: "escape" | "blur" | "outside-click") => void;
  /** called when user changes the highlighted item (for live preview) */
  onHighlight?: (item: CompletionItem | null) => void;
}

export class CompletionMenu {
  private container: HTMLDivElement;
  private listbox: HTMLUListElement;
  private items: CompletionItem[];
  private selected = 0;
  private replaceRange: { from: number; to: number };
  private onSelect: CompletionMenuOptions["onSelect"];
  private onCancel: CompletionMenuOptions["onCancel"];
  private onHighlight?: CompletionMenuOptions["onHighlight"];
  private destroyed = false;
  private keydownHandler: (ev: KeyboardEvent) => void;
  private outsideClickHandler: (ev: MouseEvent) => void;
  private blurHandler: () => void;
  private resizeHandler: () => void;

  constructor(opts: CompletionMenuOptions) {
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

    // Render items.
    this.renderItems();
    this.applyTheme();
    this.position(opts.anchor);

    shadow.appendChild(this.container);

    // Listeners (added on document/shadow so they fire even when container has no focus).
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

  private applyTheme() {
    const theme = getTheme();
    this.container.setAttribute("data-theme", theme);
  }

  private renderItems() {
    this.listbox.innerHTML = "";
    const max = this.items.length;
    const cap = 50;
    const shown = Math.min(max, cap);
    for (let i = 0; i < shown; i++) {
      const item = this.items[i]!;
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

      li.addEventListener("mouseenter", () => this.setSelected(i, /* fromMouse */ true));
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

  private setSelected(idx: number, fromMouse: boolean) {
    if (this.destroyed) return;
    const clamped = Math.max(0, Math.min(idx, this.items.length - 1));
    if (clamped === this.selected && !fromMouse) return;
    this.selected = clamped;
    const items = this.listbox.querySelectorAll(".pg4-completion-item");
    items.forEach((el, i) => {
      const li = el as HTMLLIElement;
      const active = i === clamped;
      li.classList.toggle("pg4-active", active);
      li.setAttribute("aria-selected", active ? "true" : "false");
      if (active) {
        li.scrollIntoView({ block: "nearest" });
      }
    });
    this.onHighlight?.(this.items[clamped] ?? null);
  }

  private onKeyDown(ev: KeyboardEvent) {
    if (this.destroyed) return;
    // Only intercept keys when our menu is open AND the page focus is anywhere
    // (we let pgAdmin4 editor keep keystrokes except for nav keys).
    const itemCount = this.items.length;
    const canWrap = itemCount > 0;
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        ev.stopPropagation();
        if (canWrap) {
          this.setSelected((this.selected + 1) % itemCount, false);
        }
        break;
      case "ArrowUp":
        ev.preventDefault();
        ev.stopPropagation();
        if (canWrap) {
          this.setSelected((this.selected - 1 + itemCount) % itemCount, false);
        }
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
        // Other keys (typing) are NOT intercepted; the editor continues to receive them.
        // The content script will call update() with new items as the prefix changes.
        break;
    }
  }

  private onOutsideClick(ev: MouseEvent) {
    if (this.destroyed) return;
    // Document listeners see Shadow DOM events retargeted to the overlay host,
    // so target/contains alone would treat a menu item click as an outside click.
    if (ev.composedPath().includes(this.container)) return;
    // Click was outside the menu — let pgAdmin4 keep the click but close ourselves.
    this.destroy("outside-click");
  }

  private commit() {
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
  update(items: CompletionItem[], replaceRange: { from: number; to: number }, anchor: { left: number; top: number; bottom: number }) {
    this.items = items;
    this.replaceRange = replaceRange;
    this.selected = Math.min(this.selected, Math.max(0, items.length - 1));
    this.renderItems();
    this.position(anchor);
  }

  /** Re-position the menu relative to the current cursor coordinates. */
  position(anchor: { left: number; top: number; bottom: number }) {
    // Place below the cursor if there's room, else flip above.
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

  destroy(reason: "escape" | "blur" | "outside-click" | "external") {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cleanup();
    if (reason !== "external") {
      this.onCancel(reason);
    }
  }

  private cleanup() {
    document.removeEventListener("keydown", this.keydownHandler, true);
    document.removeEventListener("mousedown", this.outsideClickHandler, true);
    window.removeEventListener("blur", this.blurHandler);
    window.removeEventListener("resize", this.resizeHandler);
    this.container.remove();
  }

  static injectStyles(shadow: ShadowRoot) {
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
        overflow-x: hidden;
        overscroll-behavior: contain;
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
}

function iconFor(kind: CompletionItem["kind"]): string {
  switch (kind) {
    case "table": return "▦";
    case "view": return "◳";
    case "column": return "⫶";
    case "function": return "ƒ";
    case "keyword": return "K";
    case "snippet": return "❯";
    case "jsonb-path": return "{}";
    case "cte": return "↻";
    default: return "•";
  }
}
