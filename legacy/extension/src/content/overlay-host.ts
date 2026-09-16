// Overlay host: a single Shadow DOM container for all extension overlays.
// SPEC §10: overlays must use Shadow DOM or prefixed classes to avoid pgAdmin4 CSS leaking in
// (and vice versa). All overlays live under #pg4-overlay-root > shadowRoot.
//
// Also detects light/dark theme from pgAdmin4 (or system preference) and exposes
// a themeChange subscription so overlays can re-skin without re-mount.

export type ThemeMode = "light" | "dark";

const THEME_ATTR = "data-pg4-theme";

let hostEl: HTMLDivElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let currentTheme: ThemeMode = "light";
const themeListeners = new Set<(mode: ThemeMode) => void>();
let themeObserver: MutationObserver | null = null;
let mediaQuery: MediaQueryList | null = null;

/** Initialize the overlay host. Safe to call multiple times. */
export function ensureOverlayHost(): { host: HTMLDivElement; shadow: ShadowRoot } {
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
  // children control their own pointerEvents; the host itself never intercepts.
  document.documentElement.appendChild(hostEl);
  shadowRoot = hostEl.attachShadow({ mode: "open" });
  injectBaseStyles(shadowRoot);
  currentTheme = detectTheme();
  shadowRoot.host.setAttribute(THEME_ATTR, currentTheme);
  startThemeWatching();
  return { host: hostEl, shadow: shadowRoot };
}

export function getShadow(): ShadowRoot {
  if (!shadowRoot) {
    ensureOverlayHost();
  }
  return shadowRoot!;
}

export function getTheme(): ThemeMode {
  return currentTheme;
}

export function onThemeChange(cb: (mode: ThemeMode) => void): () => void {
  themeListeners.add(cb);
  return () => {
    themeListeners.delete(cb);
  };
}

function setTheme(mode: ThemeMode) {
  if (mode === currentTheme) return;
  currentTheme = mode;
  shadowRoot?.host.setAttribute(THEME_ATTR, mode);
  for (const cb of themeListeners) {
    try {
      cb(mode);
    } catch {
      /* ignore listener errors */
    }
  }
}

function detectTheme(): ThemeMode {
  // Try pgAdmin4 markers first.
  const candidates = [
    document.documentElement,
    document.body,
    document.querySelector(".pgadmin-container"),
    document.querySelector("#pgcontainer"),
  ].filter(Boolean) as HTMLElement[];
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
  // Fallback to prefers-color-scheme.
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  return mq?.matches ? "dark" : "light";
}

function parseLuminance(bg: string): number | null {
  const m = bg.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1]!.split(",").map((s) => parseFloat(s.trim()));
  if (parts.length < 3) return null;
  const [r, g, b] = parts;
  // relative luminance (approximate)
  return (0.2126 * (r! / 255) + 0.7152 * (g! / 255) + 0.0722 * (b! / 255));
}

function startThemeWatching() {
  // Watch the document element for class / attribute changes that signal a theme switch.
  themeObserver = new MutationObserver(() => {
    setTheme(detectTheme());
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme", THEME_ATTR],
    subtree: false,
  });
  // Also watch body in case pgAdmin4 toggles there.
  themeObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
    subtree: false,
  });
  mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  mediaQuery?.addEventListener?.("change", () => setTheme(detectTheme()));
}

// Base styles applied to the shadow root. Overlays add their own classes; variables
// below let them adapt to theme via `data-pg4-theme`.
function injectBaseStyles(shadow: ShadowRoot) {
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
