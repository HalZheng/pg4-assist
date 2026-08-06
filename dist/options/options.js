"use strict";
(() => {
  // src/storage/chrome-storage.ts
  var DEFAULT_SETTINGS = {
    completionTriggerMode: "auto",
    pasteMode: "on",
    diagnosticsEnabled: true,
    dangerInterceptEnabled: true,
    maxCandidates: 50,
    completionShortcut: "Ctrl+Space",
    historyRetentionDays: 90,
    showSystemTables: false,
    smartPasteHintDismissed: false
  };

  // src/options/options.ts
  function $(id) {
    return document.getElementById(id);
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== void 0) e.textContent = text;
    return e;
  }
  function toast(msg, kind = "ok") {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast" + (kind === "err" ? " err" : "");
    setTimeout(() => {
      t.className = "";
      t.textContent = "";
    }, 3e3);
  }
  async function send(msg) {
    const resp = await chrome.runtime.sendMessage(msg);
    if (resp && typeof resp === "object" && "__error" in resp) {
      const r = resp;
      throw new Error(r.message);
    }
    return resp;
  }
  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  function fmtDate(iso) {
    try {
      const d = typeof iso === "number" ? new Date(iso) : new Date(iso);
      return d.toLocaleString();
    } catch {
      return String(iso);
    }
  }
  function setupTabs() {
    const buttons = document.querySelectorAll("nav button");
    buttons.forEach((b) => {
      b.addEventListener("click", () => {
        buttons.forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        const target = b.dataset.tab;
        document.querySelectorAll("section").forEach((s) => s.classList.remove("active"));
        $(`tab-${target}`).classList.add("active");
        if (target === "snapshots") void loadSnapshots();
        else if (target === "hosts") void loadHosts();
        else if (target === "settings") void loadSettings();
        else if (target === "snippets") void loadSnippets();
        else if (target === "history") void loadHistory();
        else if (target === "data") void loadDataStats();
      });
    });
  }
  var snapshotList = [];
  async function loadSnapshots() {
    try {
      snapshotList = await send({ type: "pg4:list-snapshots" });
    } catch (e) {
      toast(`Failed: ${e.message}`, "err");
      return;
    }
    const tbody = $("snap-list");
    tbody.innerHTML = "";
    if (!snapshotList.length) {
      tbody.appendChild(el("tr", void 0)).appendChild(el("td", "hint", "No snapshots yet.")).colSpan = 9;
      return;
    }
    for (const s of snapshotList) {
      const tr = el("tr");
      tr.appendChild(el("td", void 0, s.displayName));
      tr.appendChild(el("td", void 0, s.sourceFileName));
      tr.appendChild(el("td", void 0, String(s.schemaCount)));
      tr.appendChild(el("td", void 0, String(s.relationCount)));
      tr.appendChild(el("td", void 0, String(s.functionCount)));
      const warn = el("td");
      if (s.warningCount > 0) {
        warn.appendChild(el("span", "badge warn", `${s.warningCount} warnings`));
      } else {
        warn.appendChild(el("span", "badge", "ok"));
      }
      tr.appendChild(warn);
      tr.appendChild(el("td", void 0, fmtDate(s.importedAt)));
      tr.appendChild(el("td", void 0, fmtBytes(s.rawSizeBytes)));
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
  async function exportSnapshot(s) {
    try {
      const result = await send({
        type: "pg4:export-snapshot",
        snapshotId: s.snapshotId
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
      toast(`Export failed: ${e.message}`, "err");
    }
  }
  async function deleteSnapshot(s) {
    if (!confirm(`Delete snapshot "${s.displayName}"?
This also clears its host bindings, usage and history associations.`)) return;
    try {
      await send({ type: "pg4:delete-snapshot", snapshotId: s.snapshotId });
      toast("Snapshot deleted.");
      await loadSnapshots();
    } catch (e) {
      toast(`Failed: ${e.message}`, "err");
    }
  }
  function setupSnapshotImport() {
    const fileInput = $("snap-file");
    const nameInput = $("snap-name");
    const btn = $("snap-import");
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
      progress.textContent = "Reading file\u2026";
      try {
        const raw = await file.text();
        progress.textContent = `Parsing (${fmtBytes(raw.length)})\u2026`;
        const result = await send({
          type: "pg4:import-snapshot",
          displayName,
          sourceFileName: file.name,
          rawDdl: raw
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
        toast(`Import failed: ${e.message}`, "err");
      }
    });
  }
  function showWarnings(warnings) {
    let panel = document.getElementById("snap-warnings-panel");
    if (!panel) {
      panel = el("details");
      panel.id = "snap-warnings-panel";
      panel.appendChild(el("summary", void 0, `Parser warnings (${warnings.length})`));
      const wrap2 = el("div", "warn-list");
      panel.appendChild(wrap2);
      const progRow = $("snap-progress").parentElement;
      progRow?.appendChild(panel);
    }
    const summary = panel.querySelector("summary");
    summary.textContent = `Parser warnings (${warnings.length}) \u2014 click to expand`;
    const wrap = panel.querySelector(".warn-list");
    wrap.innerHTML = "";
    for (const w of warnings.slice(0, 200)) {
      const line = el("div");
      line.appendChild(el("span", "line", `L${w.line}: `));
      line.appendChild(el("span", void 0, `[${w.code}] ${w.message}`));
      wrap.appendChild(line);
    }
    if (warnings.length > 200) {
      wrap.appendChild(el("div", "hint", `\u2026and ${warnings.length - 200} more.`));
    }
  }
  async function loadHosts() {
    let hosts = [];
    try {
      hosts = await send({ type: "pg4:list-host-bindings" });
    } catch (e) {
      toast(`Failed: ${e.message}`, "err");
      return;
    }
    const tbody = $("host-list");
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
      tr.appendChild(el("td", void 0, h.origin));
      const active = el("td");
      if (h.snapshotId) {
        const meta = snapshotList.find((s) => s.snapshotId === h.snapshotId);
        const select = el("select");
        select.style.width = "240px";
        select.appendChild((() => {
          const o = el("option");
          o.value = "";
          o.textContent = "(no active snapshot)";
          return o;
        })());
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
        const select = el("select");
        select.style.width = "240px";
        select.appendChild((() => {
          const o = el("option");
          o.value = "";
          o.textContent = "(no active snapshot)";
          return o;
        })());
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
      tr.appendChild(el("td", void 0, fmtDate(h.updatedAt)));
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
    const input = $("host-input");
    const btn = $("host-add");
    btn.addEventListener("click", async () => {
      const origin = input.value.trim().replace(/\/$/, "");
      if (!origin || !/^https?:\/\//.test(origin)) {
        toast("Enter a full origin (https://...).", "err");
        return;
      }
      try {
        const r = await send({
          type: "pg4:request-host-permission",
          origin
        });
        if (!r.granted) {
          toast(`Permission not granted: ${r.error ?? "user denied"}`, "err");
          return;
        }
      } catch (e) {
        toast(`Permission failed: ${e.message}`, "err");
        return;
      }
      await send({ type: "pg4:set-host-binding", origin, snapshotId: null });
      input.value = "";
      toast("Host added.");
      await loadHosts();
    });
  }
  async function loadSettings() {
    let s;
    try {
      s = await send({ type: "pg4:get-settings" });
    } catch {
      s = DEFAULT_SETTINGS;
    }
    $("set-completion-mode").value = s.completionTriggerMode;
    $("set-max-candidates").value = String(s.maxCandidates);
    $("set-shortcut").value = s.completionShortcut;
    $("set-paste-mode").value = s.pasteMode;
    $("set-diagnostics").checked = s.diagnosticsEnabled;
    $("set-danger").checked = s.dangerInterceptEnabled;
    $("set-history-days").value = String(s.historyRetentionDays);
    $("set-system-tables").checked = s.showSystemTables;
  }
  function setupSettingsSave() {
    $("set-save").addEventListener("click", async () => {
      const patch = {
        completionTriggerMode: $("set-completion-mode").value,
        maxCandidates: parseInt($("set-max-candidates").value, 10) || 50,
        completionShortcut: $("set-shortcut").value.trim() || "Ctrl+Space",
        pasteMode: $("set-paste-mode").value,
        diagnosticsEnabled: $("set-diagnostics").checked,
        dangerInterceptEnabled: $("set-danger").checked,
        historyRetentionDays: parseInt($("set-history-days").value, 10) || 90,
        showSystemTables: $("set-system-tables").checked
      };
      try {
        await send({ type: "pg4:set-settings", patch });
        toast("Settings saved.");
      } catch (e) {
        toast(`Failed: ${e.message}`, "err");
      }
    });
    $("set-reset").addEventListener("click", async () => {
      if (!confirm("Reset all settings to defaults?")) return;
      try {
        await send({ type: "pg4:set-settings", patch: DEFAULT_SETTINGS });
        await loadSettings();
        toast("Reset to defaults.");
      } catch (e) {
        toast(`Failed: ${e.message}`, "err");
      }
    });
  }
  var snippetsList = [];
  var activeSnippetId = null;
  async function loadSnippets() {
    try {
      snippetsList = await send({ type: "pg4:list-snippets" });
    } catch (e) {
      toast(`Failed: ${e.message}`, "err");
      return;
    }
    const tbody = $("snip-list");
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
      tr.appendChild(el("td", void 0, s.title));
      tr.appendChild(el("td", void 0, s.category));
      tr.appendChild(el("td", void 0, String(s.useCount)));
      tr.appendChild(el("td", void 0, fmtDate(s.updatedAt)));
      const actions = el("td");
      const edit = el("button", "secondary", "Edit");
      edit.addEventListener("click", () => {
        activeSnippetId = s.id;
        $("snip-id").value = s.id;
        $("snip-title").value = s.title;
        $("snip-category").value = s.category;
        $("snip-description").value = s.description ?? "";
        $("snip-body").value = s.body;
      });
      actions.appendChild(edit);
      tr.appendChild(actions);
      tbody.appendChild(tr);
    }
  }
  function setupSnippetEditor() {
    $("snip-new").addEventListener("click", () => {
      activeSnippetId = null;
      $("snip-id").value = "(auto)";
      $("snip-title").value = "";
      $("snip-category").value = "";
      $("snip-description").value = "";
      $("snip-body").value = "";
    });
    $("snip-save").addEventListener("click", async () => {
      const title = $("snip-title").value.trim();
      const body = $("snip-body").value;
      if (!title || !body) {
        toast("Title and body are required.", "err");
        return;
      }
      const id = activeSnippetId ?? `snip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const snippet = {
        id,
        title,
        category: $("snip-category").value.trim() || "general",
        body,
        description: $("snip-description").value.trim() || void 0,
        variables: extractVariables(body),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
        useCount: snippetsList.find((s) => s.id === id)?.useCount ?? 0
      };
      try {
        await send({ type: "pg4:save-snippet", snippet });
        activeSnippetId = id;
        $("snip-id").value = id;
        toast("Snippet saved.");
        await loadSnippets();
      } catch (e) {
        toast(`Failed: ${e.message}`, "err");
      }
    });
    $("snip-delete").addEventListener("click", async () => {
      if (!activeSnippetId) return;
      if (!confirm("Delete this snippet?")) return;
      try {
        await send({ type: "pg4:delete-snippet", id: activeSnippetId });
        activeSnippetId = null;
        $("snip-id").value = "(auto)";
        $("snip-title").value = "";
        $("snip-body").value = "";
        toast("Snippet deleted.");
        await loadSnippets();
      } catch (e) {
        toast(`Failed: ${e.message}`, "err");
      }
    });
  }
  function extractVariables(body) {
    const matches = body.matchAll(/\$\{([a-zA-Z_][\w]*)(?::([^}]*))?\}/g);
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const m of matches) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      const def = m[2];
      out.push({ name, defaultValue: def ?? void 0, required: def === void 0 });
    }
    return out;
  }
  async function loadHistory() {
    try {
      snapshotList = await send({ type: "pg4:list-snapshots" });
    } catch {
    }
    const sel = $("hist-snap");
    sel.innerHTML = '<option value="">(any)</option>';
    for (const s of snapshotList) {
      const o = el("option");
      o.value = s.snapshotId;
      o.textContent = s.displayName;
      sel.appendChild(o);
    }
    await searchHistory();
  }
  async function searchHistory() {
    const kw = $("hist-kw").value.trim() || void 0;
    const snapshotId = $("hist-snap").value || void 0;
    const fromStr = $("hist-from").value;
    const toStr = $("hist-to").value;
    const from = fromStr ? new Date(fromStr).getTime() : void 0;
    const to = toStr ? new Date(toStr).getTime() + 24 * 60 * 60 * 1e3 - 1 : void 0;
    let rows = [];
    try {
      rows = await send({
        type: "pg4:list-history",
        opts: { limit: 200, keyword: kw, snapshotId, from, to }
      });
    } catch (e) {
      toast(`Failed: ${e.message}`, "err");
      return;
    }
    const tbody = $("hist-list");
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
      tr.appendChild(el("td", void 0, fmtDate(r.executedAt)));
      tr.appendChild(el("td", void 0, r.origin));
      const snapCell = el("td", void 0);
      const snap = snapshotList.find((s) => s.snapshotId === r.snapshotId);
      if (snap) snapCell.textContent = snap.displayName;
      tr.appendChild(snapCell);
      const sqlCell = el("td");
      const pre = el("pre");
      pre.textContent = r.sql.length > 400 ? r.sql.slice(0, 400) + "\u2026" : r.sql;
      sqlCell.appendChild(pre);
      tr.appendChild(sqlCell);
      tbody.appendChild(tr);
    }
  }
  function setupHistorySearch() {
    $("hist-search").addEventListener("click", () => void searchHistory());
    $("hist-clear").addEventListener("click", async () => {
      if (!confirm("Clear ALL query history? This cannot be undone.")) return;
      try {
        await send({ type: "pg4:clear-history" });
        toast("History cleared.");
        await searchHistory();
      } catch (e) {
        toast(`Failed: ${e.message}`, "err");
      }
    });
  }
  async function loadDataStats() {
    const el2 = $("data-stats");
    el2.textContent = "Loading\u2026";
    try {
      const stats = await send({ type: "pg4:storage-stats" });
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
      el2.textContent = `Failed: ${e.message}`;
    }
    function li(text) {
      return el("li", void 0, text);
    }
  }
  function setupDataActions() {
    $("data-export").addEventListener("click", async () => {
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
        toast(`Failed: ${e.message}`, "err");
      }
    });
    $("data-wipe-history").addEventListener("click", async () => {
      if (!confirm("Wipe ALL query history? This cannot be undone.")) return;
      try {
        await send({ type: "pg4:clear-history" });
        toast("History wiped.");
        await loadDataStats();
      } catch (e) {
        toast(`Failed: ${e.message}`, "err");
      }
    });
    $("data-wipe-all").addEventListener("click", async () => {
      if (!confirm("Wipe ALL local PG4 data (snapshots, history, snippets, usage, settings)? This cannot be undone.")) return;
      if (!confirm("Really wipe everything? This is destructive.")) return;
      try {
        const snaps = await send({ type: "pg4:list-snapshots" });
        for (const s of snaps) {
          await send({ type: "pg4:delete-snapshot", snapshotId: s.snapshotId });
        }
        await send({ type: "pg4:clear-history" });
        const snips = await send({ type: "pg4:list-snippets" });
        for (const sn of snips) {
          await send({ type: "pg4:delete-snippet", id: sn.id });
        }
        await send({ type: "pg4:set-settings", patch: DEFAULT_SETTINGS });
        toast("All local data wiped.");
        await loadDataStats();
      } catch (e) {
        toast(`Failed: ${e.message}`, "err");
      }
    });
  }
  async function init() {
    try {
      const manifest = chrome.runtime.getManifest();
      $("version").textContent = manifest.version;
      $("about-version").textContent = manifest.version;
    } catch {
    }
    setupTabs();
    setupSnapshotImport();
    setupHostAdd();
    setupSettingsSave();
    setupSnippetEditor();
    setupHistorySearch();
    setupDataActions();
    await loadSnapshots();
  }
  init().catch((e) => {
    console.error("[pg4 options] init failed:", e);
    toast(`Init failed: ${e.message}`, "err");
  });
})();
