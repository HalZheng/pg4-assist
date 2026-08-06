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

  // src/popup/popup.ts
  function $(id) {
    return document.getElementById(id);
  }
  function setStatus(text, cls) {
    const el = $("status");
    el.textContent = text;
    el.className = "status " + cls;
  }
  async function send(msg) {
    const r = await chrome.runtime.sendMessage(msg);
    if (r && typeof r === "object" && "__error" in r) {
      throw new Error(r.message);
    }
    return r;
  }
  async function init() {
    $("open-options").addEventListener("click", () => {
      if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
      else window.open(chrome.runtime.getURL("options/options.html"));
    });
    $("open-history").addEventListener("click", () => {
      if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
      else window.open(chrome.runtime.getURL("options/options.html"));
    });
    $("force-trigger").addEventListener("click", async () => {
      try {
        await send({ type: "pg4:focus-trigger" });
        window.close();
      } catch (e) {
        setStatus(`Failed: ${e.message}`, "err");
      }
    });
    let settings = DEFAULT_SETTINGS;
    let snapshots = [];
    let bindings = [];
    try {
      [settings, snapshots, bindings] = await Promise.all([
        send({ type: "pg4:get-settings" }),
        send({ type: "pg4:list-snapshots" }),
        send({ type: "pg4:list-host-bindings" })
      ]);
    } catch (e) {
      setStatus(`Error: ${e.message}`, "err");
      return;
    }
    const sel = $("snapshot");
    sel.innerHTML = '<option value="">(no active snapshot)</option>';
    for (const s of snapshots) {
      const o = document.createElement("option");
      o.value = s.snapshotId;
      o.textContent = `${s.displayName} (${s.relationCount} rels)`;
      sel.appendChild(o);
    }
    let activeOrigin = null;
    let activeSnapshotId = null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url) {
        const u = new URL(tab.url);
        activeOrigin = u.origin;
        const binding = bindings.find((b) => b.origin === activeOrigin);
        activeSnapshotId = binding?.snapshotId ?? null;
        $("origin-row").style.display = "flex";
        $("origin").textContent = activeOrigin;
        sel.value = activeSnapshotId ?? "";
      }
    } catch {
    }
    renderSnapshotMeta(activeSnapshotId, snapshots);
    sel.addEventListener("change", async () => {
      const newId = sel.value || null;
      if (!activeOrigin) {
        setStatus("Open a pgAdmin4 tab first.", "warn");
        return;
      }
      try {
        await send({ type: "pg4:set-host-binding", origin: activeOrigin, snapshotId: newId });
        setStatus("Snapshot updated.", "ok");
        renderSnapshotMeta(newId, snapshots);
      } catch (e) {
        setStatus(`Failed: ${e.message}`, "err");
      }
    });
    if (activeSnapshotId) {
      setStatus("Active", "ok");
    } else if (activeOrigin) {
      setStatus("No snapshot", "warn");
    } else {
      setStatus("No pgAdmin4 tab", "warn");
    }
    $("danger-status").textContent = settings.dangerInterceptEnabled ? "On" : "Off";
    $("diag-status").textContent = settings.diagnosticsEnabled ? "On" : "Off";
    $("editors").textContent = "\u2014";
    function renderSnapshotMeta(id, snaps) {
      const el = $("snapshot-meta");
      if (!id) {
        el.textContent = "";
        return;
      }
      const m = snaps.find((s) => s.snapshotId === id);
      if (!m) {
        el.textContent = "";
        return;
      }
      el.textContent = `${m.schemaCount} schemas \xB7 ${m.relationCount} relations \xB7 ${m.functionCount} functions`;
    }
  }
  init().catch((e) => {
    console.error("[pg4 popup] init failed:", e);
    setStatus(`Error: ${e.message}`, "err");
  });
})();
