// Options page logic (SPEC §11.3). Communicates with the background service worker
// via chrome.runtime.sendMessage. Rendered as an IIFE bundle.

import { DEFAULT_SETTINGS, type Pg4Settings } from "../storage/chrome-storage";
import type { SnapshotMeta, HostBinding, Snippet, QueryHistoryEntry, DdlWarning } from "../types/editor";

// ---- Helpers --------------------------------------------------------------

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function toast(msg: string, kind: "ok" | "err" = "ok") {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (kind === "err" ? " err" : "");
  setTimeout(() => {
    t.className = "";
    t.textContent = "";
  }, 3000);
}

async function send<T = unknown>(msg: unknown): Promise<T> {
  const resp = (await chrome.runtime.sendMessage(msg)) as T | { __error: true; message: string };
  if (resp && typeof resp === "object" && "__error" in (resp as any)) {
    const r = resp as { __error: true; message: string };
    throw new Error(r.message);
  }
  return resp as T;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDate(iso: string | number): string {
  try {
    const d = typeof iso === "number" ? new Date(iso) : new Date(iso);
    return d.toLocaleString();
  } catch {
    return String(iso);
  }
}

// ---- Tab navigation -------------------------------------------------------

function setupTabs() {
  const buttons = document.querySelectorAll<HTMLButtonElement>("nav button");
  buttons.forEach((b) => {
    b.addEventListener("click", () => {
      buttons.forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      const target = b.dataset.tab!;
      document.querySelectorAll("section").forEach((s) => s.classList.remove("active"));
      $(`tab-${target}`).classList.add("active");
      // Lazy-load sections.
      if (target === "snapshots") void loadSnapshots();
      else if (target === "hosts") void loadHosts();
      else if (target === "settings") void loadSettings();
      else if (target === "snippets") void loadSnippets();
      else if (target === "history") void loadHistory();
      else if (target === "data") void loadDataStats();
    });
  });
}

// ---- Snapshots ------------------------------------------------------------

let snapshotList: SnapshotMeta[] = [];

async function loadSnapshots() {
  try {
    snapshotList = await send<SnapshotMeta[]>({ type: "pg4:list-snapshots" });
  } catch (e) {
    toast(`Failed: ${(e as Error).message}`, "err");
    return;
  }
  const tbody = $<HTMLTableSectionElement>("snap-list");
  tbody.innerHTML = "";
  if (!snapshotList.length) {
    tbody.appendChild(el("tr", undefined)).appendChild(el("td", "hint", "No snapshots yet.")).colSpan = 9;
    return;
  }
  for (const s of snapshotList) {
    const tr = el("tr");
    tr.appendChild(el("td", undefined, s.displayName));
    tr.appendChild(el("td", undefined, s.sourceFileName));
    tr.appendChild(el("td", undefined, String(s.schemaCount)));
    tr.appendChild(el("td", undefined, String(s.relationCount)));
    tr.appendChild(el("td", undefined, String(s.functionCount)));
    const warn = el("td");
    if (s.warningCount > 0) {
      warn.appendChild(el("span", "badge warn", `${s.warningCount} warnings`));
    } else {
      warn.appendChild(el("span", "badge", "ok"));
    }
    tr.appendChild(warn);
    tr.appendChild(el("td", undefined, fmtDate(s.importedAt)));
    tr.appendChild(el("td", undefined, fmtBytes(s.rawSizeBytes)));
    const actions = el("td");
    const exportBtn = el("button", "secondary", "Export");
    exportBtn.addEventListener("click", () => exportSnapshot(s));
    const deleteBtn = el("button", "danger", "Delete");
    deleteBtn.addEventListener("click", () => deleteSnapshot(s));
    actions.appendChild(exportBtn);
    actions.appendChild(document.createTextNode(" "));
    actions.appendChild(deleteBtn);
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
}

async function exportSnapshot(s: SnapshotMeta) {
  try {
    const result = await send<{ snapshot: { snapshotId: string; meta: SnapshotMeta; rawDdl: string }; graph: unknown; usage: unknown }>({
      type: "pg4:export-snapshot",
      snapshotId: s.snapshotId,
    });
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = el("a");
    a.href = url;
    a.download = `${s.displayName}.pg4snap.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Snapshot exported.");
  } catch (e) {
    toast(`Export failed: ${(e as Error).message}`, "err");
  }
}

async function deleteSnapshot(s: SnapshotMeta) {
  if (!confirm(`Delete snapshot "${s.displayName}"?\nThis also clears its host bindings, usage and history associations.`)) return;
  try {
    await send({ type: "pg4:delete-snapshot", snapshotId: s.snapshotId });
    toast("Snapshot deleted.");
    await loadSnapshots();
  } catch (e) {
    toast(`Failed: ${(e as Error).message}`, "err");
  }
}

function setupSnapshotImport() {
  const fileInput = $<HTMLInputElement>("snap-file");
  const nameInput = $<HTMLInputElement>("snap-name");
  const btn = $<HTMLButtonElement>("snap-import");
  const progress = $("snap-progress");
  btn.addEventListener("click", async () => {
    const file = fileInput.files?.[0];
    if (!file) {
      toast("Choose a DDL file first.", "err");
      return;
    }
    const displayName = nameInput.value.trim() || file.name.replace(/\.(sql|txt|ddl)$/i, "");
    if (!displayName) {
      toast("Provide a display name.", "err");
      return;
    }
    progress.textContent = "Reading file…";
    try {
      const raw = await file.text();
      progress.textContent = `Parsing (${fmtBytes(raw.length)})…`;
      const result = await send<{ snapshotId: string; meta: SnapshotMeta; warnings: DdlWarning[] }>({
        type: "pg4:import-snapshot",
        displayName,
        sourceFileName: file.name,
        rawDdl: raw,
      });
      progress.textContent = "";
      if (result.warnings.length) {
        toast(`Imported with ${result.warnings.length} warnings.`);
        showWarnings(result.warnings);
      } else {
        toast("Snapshot imported.");
      }
      nameInput.value = "";
      fileInput.value = "";
      await loadSnapshots();
    } catch (e) {
      progress.textContent = "";
      toast(`Import failed: ${(e as Error).message}`, "err");
    }
  });
}

function showWarnings(warnings: DdlWarning[]) {
  // Render as a collapsible panel below the import button.
  let panel = document.getElementById("snap-warnings-panel");
  if (!panel) {
    panel = el("details");
    panel.id = "snap-warnings-panel";
    panel.appendChild(el("summary", undefined, `Parser warnings (${warnings.length})`));
    const wrap = el("div", "warn-list");
    panel.appendChild(wrap);
    const progRow = $("snap-progress").parentElement;
    progRow?.appendChild(panel);
  }
  const summary = panel.querySelector("summary");
  summary!.textContent = `Parser warnings (${warnings.length}) — click to expand`;
  const wrap = panel.querySelector(".warn-list") as HTMLElement;
  wrap.innerHTML = "";
  for (const w of warnings.slice(0, 200)) {
    const line = el("div");
    line.appendChild(el("span", "line", `L${w.line}: `));
    line.appendChild(el("span", undefined, `[${w.code}] ${w.message}`));
    wrap.appendChild(line);
  }
  if (warnings.length > 200) {
    wrap.appendChild(el("div", "hint", `…and ${warnings.length - 200} more.`));
  }
}

// ---- Hosts ----------------------------------------------------------------

async function loadHosts() {
  let hosts: HostBinding[] = [];
  try {
    hosts = await send<HostBinding[]>({ type: "pg4:list-host-bindings" });
  } catch (e) {
    toast(`Failed: ${(e as Error).message}`, "err");
    return;
  }
  const tbody = $<HTMLTableSectionElement>("host-list");
  tbody.innerHTML = "";
  if (!hosts.length) {
    const tr = el("tr");
    const td = el("td", "hint", "No hosts configured.");
    td.colSpan = 4;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const h of hosts) {
    const tr = el("tr");
    tr.appendChild(el("td", undefined, h.origin));
    const active = el("td");
    if (h.snapshotId) {
      const meta = snapshotList.find((s) => s.snapshotId === h.snapshotId);
      const select = el("select") as HTMLSelectElement;
      select.style.width = "240px";
      select.appendChild((() => { const o = el("option"); o.value = ""; o.textContent = "(no active snapshot)"; return o; })());
      for (const s of snapshotList) {
        const o = el("option");
        o.value = s.snapshotId;
        o.textContent = s.displayName;
        if (s.snapshotId === h.snapshotId) o.selected = true;
        select.appendChild(o);
      }
      select.addEventListener("change", async () => {
        await send({ type: "pg4:set-host-binding", origin: h.origin, snapshotId: select.value || null });
        toast("Active snapshot updated.");
      });
      active.appendChild(select);
      if (meta) active.appendChild(el("span", "hint", ` (${meta.relationCount} rels)`));
    } else {
      const select = el("select") as HTMLSelectElement;
      select.style.width = "240px";
      select.appendChild((() => { const o = el("option"); o.value = ""; o.textContent = "(no active snapshot)"; return o; })());
      for (const s of snapshotList) {
        const o = el("option");
        o.value = s.snapshotId;
        o.textContent = s.displayName;
        select.appendChild(o);
      }
      select.addEventListener("change", async () => {
        await send({ type: "pg4:set-host-binding", origin: h.origin, snapshotId: select.value || null });
        toast("Active snapshot updated.");
      });
      active.appendChild(select);
    }
    tr.appendChild(active);
    tr.appendChild(el("td", undefined, fmtDate(h.updatedAt)));
    const actions = el("td");
    const remove = el("button", "danger", "Remove");
    remove.addEventListener("click", async () => {
      if (!confirm(`Remove host binding for ${h.origin}?`)) return;
      await send({ type: "pg4:set-host-binding", origin: h.origin, snapshotId: null });
      await loadHosts();
    });
    actions.appendChild(remove);
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
}

function setupHostAdd() {
  const input = $<HTMLInputElement>("host-input");
  const btn = $<HTMLButtonElement>("host-add");
  btn.addEventListener("click", async () => {
    const origin = input.value.trim().replace(/\/$/, "");
    if (!origin || !/^https?:\/\//.test(origin)) {
      toast("Enter a full origin (https://...).", "err");
      return;
    }
    // First request optional host permission.
    try {
      const r = await send<{ granted: boolean; error?: string }>({
        type: "pg4:request-host-permission",
        origin,
      });
      if (!r.granted) {
        toast(`Permission not granted: ${r.error ?? "user denied"}`, "err");
        return;
      }
    } catch (e) {
      toast(`Permission failed: ${(e as Error).message}`, "err");
      return;
    }
    // Create empty host binding (no active snapshot yet).
    await send({ type: "pg4:set-host-binding", origin, snapshotId: null });
    input.value = "";
    toast("Host added.");
    await loadHosts();
  });
}

// ---- Settings -------------------------------------------------------------

async function loadSettings() {
  let s: Pg4Settings;
  try {
    s = await send<Pg4Settings>({ type: "pg4:get-settings" });
  } catch {
    s = DEFAULT_SETTINGS;
  }
  ($<HTMLSelectElement>("set-completion-mode")).value = s.completionTriggerMode;
  ($<HTMLInputElement>("set-max-candidates")).value = String(s.maxCandidates);
  ($<HTMLInputElement>("set-shortcut")).value = s.completionShortcut;
  ($<HTMLSelectElement>("set-paste-mode")).value = s.pasteMode;
  ($<HTMLInputElement>("set-diagnostics")).checked = s.diagnosticsEnabled;
  ($<HTMLInputElement>("set-danger")).checked = s.dangerInterceptEnabled;
  ($<HTMLInputElement>("set-history-days")).value = String(s.historyRetentionDays);
  ($<HTMLInputElement>("set-system-tables")).checked = s.showSystemTables;
}

function setupSettingsSave() {
  $<HTMLButtonElement>("set-save").addEventListener("click", async () => {
    const patch: Partial<Pg4Settings> = {
      completionTriggerMode: ($<HTMLSelectElement>("set-completion-mode")).value as Pg4Settings["completionTriggerMode"],
      maxCandidates: parseInt(($<HTMLInputElement>("set-max-candidates")).value, 10) || 50,
      completionShortcut: ($<HTMLInputElement>("set-shortcut")).value.trim() || "Ctrl+Space",
      pasteMode: ($<HTMLSelectElement>("set-paste-mode")).value as Pg4Settings["pasteMode"],
      diagnosticsEnabled: ($<HTMLInputElement>("set-diagnostics")).checked,
      dangerInterceptEnabled: ($<HTMLInputElement>("set-danger")).checked,
      historyRetentionDays: parseInt(($<HTMLInputElement>("set-history-days")).value, 10) || 90,
      showSystemTables: ($<HTMLInputElement>("set-system-tables")).checked,
    };
    try {
      await send({ type: "pg4:set-settings", patch });
      toast("Settings saved.");
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`, "err");
    }
  });
  $<HTMLButtonElement>("set-reset").addEventListener("click", async () => {
    if (!confirm("Reset all settings to defaults?")) return;
    try {
      await send({ type: "pg4:set-settings", patch: DEFAULT_SETTINGS });
      await loadSettings();
      toast("Reset to defaults.");
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`, "err");
    }
  });
}

// ---- Snippets -------------------------------------------------------------

let snippetsList: Snippet[] = [];
let activeSnippetId: string | null = null;

async function loadSnippets() {
  try {
    snippetsList = await send<Snippet[]>({ type: "pg4:list-snippets" });
  } catch (e) {
    toast(`Failed: ${(e as Error).message}`, "err");
    return;
  }
  const tbody = $<HTMLTableSectionElement>("snip-list");
  tbody.innerHTML = "";
  if (!snippetsList.length) {
    const tr = el("tr");
    const td = el("td", "hint", "No snippets yet.");
    td.colSpan = 5;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const s of snippetsList) {
    const tr = el("tr");
    tr.appendChild(el("td", undefined, s.title));
    tr.appendChild(el("td", undefined, s.category));
    tr.appendChild(el("td", undefined, String(s.useCount)));
    tr.appendChild(el("td", undefined, fmtDate(s.updatedAt)));
    const actions = el("td");
    const edit = el("button", "secondary", "Edit");
    edit.addEventListener("click", () => {
      activeSnippetId = s.id;
      ($<HTMLInputElement>("snip-id")).value = s.id;
      ($<HTMLInputElement>("snip-title")).value = s.title;
      ($<HTMLInputElement>("snip-category")).value = s.category;
      ($<HTMLInputElement>("snip-description")).value = s.description ?? "";
      ($<HTMLTextAreaElement>("snip-body")).value = s.body;
    });
    actions.appendChild(edit);
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
}

function setupSnippetEditor() {
  $<HTMLButtonElement>("snip-new").addEventListener("click", () => {
    activeSnippetId = null;
    ($<HTMLInputElement>("snip-id")).value = "(auto)";
    ($<HTMLInputElement>("snip-title")).value = "";
    ($<HTMLInputElement>("snip-category")).value = "";
    ($<HTMLInputElement>("snip-description")).value = "";
    ($<HTMLTextAreaElement>("snip-body")).value = "";
  });
  $<HTMLButtonElement>("snip-save").addEventListener("click", async () => {
    const title = ($<HTMLInputElement>("snip-title")).value.trim();
    const body = ($<HTMLTextAreaElement>("snip-body")).value;
    if (!title || !body) {
      toast("Title and body are required.", "err");
      return;
    }
    const id = activeSnippetId ?? `snip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const snippet: Snippet = {
      id,
      title,
      category: ($<HTMLInputElement>("snip-category")).value.trim() || "general",
      body,
      description: ($<HTMLInputElement>("snip-description")).value.trim() || undefined,
      variables: extractVariables(body),
      updatedAt: new Date().toISOString(),
      useCount: snippetsList.find((s) => s.id === id)?.useCount ?? 0,
    };
    try {
      await send({ type: "pg4:save-snippet", snippet });
      activeSnippetId = id;
      ($<HTMLInputElement>("snip-id")).value = id;
      toast("Snippet saved.");
      await loadSnippets();
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`, "err");
    }
  });
  $<HTMLButtonElement>("snip-delete").addEventListener("click", async () => {
    if (!activeSnippetId) return;
    if (!confirm("Delete this snippet?")) return;
    try {
      await send({ type: "pg4:delete-snippet", id: activeSnippetId });
      activeSnippetId = null;
      ($<HTMLInputElement>("snip-id")).value = "(auto)";
      ($<HTMLInputElement>("snip-title")).value = "";
      ($<HTMLTextAreaElement>("snip-body")).value = "";
      toast("Snippet deleted.");
      await loadSnippets();
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`, "err");
    }
  });
}

function extractVariables(body: string): Array<{ name: string; defaultValue?: string; required: boolean }> {
  const matches = body.matchAll(/\$\{([a-zA-Z_][\w]*)(?::([^}]*))?\}/g);
  const seen = new Set<string>();
  const out: Array<{ name: string; defaultValue?: string; required: boolean }> = [];
  for (const m of matches) {
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    const def = m[2];
    out.push({ name, defaultValue: def ?? undefined, required: def === undefined });
  }
  return out;
}

// ---- History --------------------------------------------------------------

async function loadHistory() {
  // populate snapshot filter dropdown
  try {
    snapshotList = await send<SnapshotMeta[]>({ type: "pg4:list-snapshots" });
  } catch {
    /* ignore */
  }
  const sel = $<HTMLSelectElement>("hist-snap");
  sel.innerHTML = '<option value="">(any)</option>';
  for (const s of snapshotList) {
    const o = el("option");
    o.value = s.snapshotId;
    o.textContent = s.displayName;
    sel.appendChild(o);
  }
  // Search with no filters returns latest 200.
  await searchHistory();
}

async function searchHistory() {
  const kw = ($<HTMLInputElement>("hist-kw")).value.trim() || undefined;
  const snapshotId = ($<HTMLSelectElement>("hist-snap")).value || undefined;
  const fromStr = ($<HTMLInputElement>("hist-from")).value;
  const toStr = ($<HTMLInputElement>("hist-to")).value;
  const from = fromStr ? new Date(fromStr).getTime() : undefined;
  const to = toStr ? new Date(toStr).getTime() + 24 * 60 * 60 * 1000 - 1 : undefined;
  let rows: QueryHistoryEntry[] = [];
  try {
    rows = await send<QueryHistoryEntry[]>({
      type: "pg4:list-history",
      opts: { limit: 200, keyword: kw, snapshotId, from, to },
    });
  } catch (e) {
    toast(`Failed: ${(e as Error).message}`, "err");
    return;
  }
  const tbody = $<HTMLTableSectionElement>("hist-list");
  tbody.innerHTML = "";
  if (!rows.length) {
    const tr = el("tr");
    const td = el("td", "hint", "No history yet.");
    td.colSpan = 4;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const r of rows) {
    const tr = el("tr");
    tr.appendChild(el("td", undefined, fmtDate(r.executedAt)));
    tr.appendChild(el("td", undefined, r.origin));
    const snapCell = el("td", undefined);
    const snap = snapshotList.find((s) => s.snapshotId === r.snapshotId);
    if (snap) snapCell.textContent = snap.displayName;
    tr.appendChild(snapCell);
    const sqlCell = el("td");
    const pre = el("pre");
    pre.textContent = r.sql.length > 400 ? r.sql.slice(0, 400) + "…" : r.sql;
    sqlCell.appendChild(pre);
    tr.appendChild(sqlCell);
    tbody.appendChild(tr);
  }
}

function setupHistorySearch() {
  $<HTMLButtonElement>("hist-search").addEventListener("click", () => void searchHistory());
  $<HTMLButtonElement>("hist-clear").addEventListener("click", async () => {
    if (!confirm("Clear ALL query history? This cannot be undone.")) return;
    try {
      await send({ type: "pg4:clear-history" });
      toast("History cleared.");
      await searchHistory();
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`, "err");
    }
  });
}

// ---- Data & Privacy -------------------------------------------------------

async function loadDataStats() {
  const el2 = $("data-stats");
  el2.textContent = "Loading…";
  try {
    const stats = await send<{
      usage: number;
      quota: number;
      totalRawDdlBytes: number;
      snapshots: Array<{ id: string; displayName: string; rawSizeBytes: number }>;
    }>({ type: "pg4:storage-stats" });
    el2.innerHTML = "";
    const ul = el("ul");
    ul.appendChild(li(`Browser storage used: ${fmtBytes(stats.usage)} / ${fmtBytes(stats.quota)}`));
    ul.appendChild(li(`Total DDL bytes stored: ${fmtBytes(stats.totalRawDdlBytes)}`));
    ul.appendChild(li(`Snapshots: ${stats.snapshots.length}`));
    el2.appendChild(ul);
    if (stats.snapshots.length) {
      const sub = el("ul");
      for (const s of stats.snapshots) {
        sub.appendChild(li(`${s.displayName}: ${fmtBytes(s.rawSizeBytes)}`));
      }
      el2.appendChild(sub);
    }
  } catch (e) {
    el2.textContent = `Failed: ${(e as Error).message}`;
  }
  function li(text: string): HTMLLIElement {
    return el("li", undefined, text) as HTMLLIElement;
  }
}

function setupDataActions() {
  $<HTMLButtonElement>("data-export").addEventListener("click", async () => {
    try {
      const data = await send({ type: "pg4:export-all" });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = el("a");
      a.href = url;
      a.download = `pg4-export-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`, "err");
    }
  });
  $<HTMLButtonElement>("data-wipe-history").addEventListener("click", async () => {
    if (!confirm("Wipe ALL query history? This cannot be undone.")) return;
    try {
      await send({ type: "pg4:clear-history" });
      toast("History wiped.");
      await loadDataStats();
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`, "err");
    }
  });
  $<HTMLButtonElement>("data-wipe-all").addEventListener("click", async () => {
    if (!confirm("Wipe ALL local PG4 data (snapshots, history, snippets, usage, settings)? This cannot be undone.")) return;
    if (!confirm("Really wipe everything? This is destructive.")) return;
    try {
      // wipe via IndexedDB deleteDatabase — handled by background? For now, delete each snapshot + clear history + clear snippets + reset settings.
      const snaps = await send<SnapshotMeta[]>({ type: "pg4:list-snapshots" });
      for (const s of snaps) {
        await send({ type: "pg4:delete-snapshot", snapshotId: s.snapshotId });
      }
      await send({ type: "pg4:clear-history" });
      // Wipe snippets
      const snips = await send<Snippet[]>({ type: "pg4:list-snippets" });
      for (const sn of snips) {
        await send({ type: "pg4:delete-snippet", id: sn.id });
      }
      // Reset settings
      await send({ type: "pg4:set-settings", patch: DEFAULT_SETTINGS });
      toast("All local data wiped.");
      await loadDataStats();
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`, "err");
    }
  });
}

// ---- Init -----------------------------------------------------------------

async function init() {
  // Version stamp
  try {
    const manifest = chrome.runtime.getManifest();
    ($<HTMLSpanElement>("version")).textContent = manifest.version;
    ($<HTMLSpanElement>("about-version")).textContent = manifest.version;
  } catch {
    /* ignore */
  }

  setupTabs();
  setupSnapshotImport();
  setupHostAdd();
  setupSettingsSave();
  setupSnippetEditor();
  setupHistorySearch();
  setupDataActions();

  // Pre-load first tab.
  await loadSnapshots();
  // Snapshot list used by hosts + history tabs; preload.
  // (already loaded by loadSnapshots).
}

init().catch((e) => {
  console.error("[pg4 options] init failed:", e);
  toast(`Init failed: ${(e as Error).message}`, "err");
});

export {};
