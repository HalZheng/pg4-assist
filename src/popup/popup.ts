// Popup UI (SPEC §10). Shows current state, snapshot switcher, quick actions.
// Communicates with the background service worker for settings / snapshots.

import { DEFAULT_SETTINGS, type Pg4Settings } from "../storage/chrome-storage";
import type { SnapshotMeta, HostBinding } from "../types/editor";

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function setStatus(text: string, cls: "ok" | "warn" | "err") {
  const el = $<HTMLSpanElement>("status");
  el.textContent = text;
  el.className = "status " + cls;
}

async function send<T = unknown>(msg: unknown): Promise<T> {
  const r = (await chrome.runtime.sendMessage(msg)) as T | { __error: true; message: string };
  if (r && typeof r === "object" && "__error" in (r as any)) {
    throw new Error((r as { __error: true; message: string }).message);
  }
  return r as T;
}

async function init() {
  // Default action buttons.
  $<HTMLButtonElement>("open-options").addEventListener("click", () => {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else window.open(chrome.runtime.getURL("options/options.html"));
  });
  $<HTMLButtonElement>("open-history").addEventListener("click", () => {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else window.open(chrome.runtime.getURL("options/options.html"));
  });
  $<HTMLButtonElement>("force-trigger").addEventListener("click", async () => {
    try {
      await send({ type: "pg4:focus-trigger" });
      window.close();
    } catch (e) {
      setStatus(`Failed: ${(e as Error).message}`, "err");
    }
  });

  // Load settings + snapshots + host bindings.
  let settings: Pg4Settings = DEFAULT_SETTINGS;
  let snapshots: SnapshotMeta[] = [];
  let bindings: HostBinding[] = [];
  try {
    [settings, snapshots, bindings] = await Promise.all([
      send<Pg4Settings>({ type: "pg4:get-settings" }),
      send<SnapshotMeta[]>({ type: "pg4:list-snapshots" }),
      send<HostBinding[]>({ type: "pg4:list-host-bindings" }),
    ]);
  } catch (e) {
    setStatus(`Error: ${(e as Error).message}`, "err");
    return;
  }

  // Populate snapshot selector.
  const sel = $<HTMLSelectElement>("snapshot");
  sel.innerHTML = '<option value="">(no active snapshot)</option>';
  for (const s of snapshots) {
    const o = document.createElement("option");
    o.value = s.snapshotId;
    o.textContent = `${s.displayName} (${s.relationCount} rels)`;
    sel.appendChild(o);
  }

  // Determine the active tab's origin (if any) — for showing the right active snapshot.
  let activeOrigin: string | null = null;
  let activeSnapshotId: string | null = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      const u = new URL(tab.url);
      activeOrigin = u.origin;
      const binding = bindings.find((b) => b.origin === activeOrigin);
      activeSnapshotId = binding?.snapshotId ?? null;
      $<HTMLDivElement>("origin-row").style.display = "flex";
      $<HTMLSpanElement>("origin").textContent = activeOrigin;
      sel.value = activeSnapshotId ?? "";
    }
  } catch {
    /* no active tab — ignore */
  }

  // Show snapshot meta.
  renderSnapshotMeta(activeSnapshotId, snapshots);

  // Snapshot change handler.
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
      setStatus(`Failed: ${(e as Error).message}`, "err");
    }
  });

  // Status summary.
  if (activeSnapshotId) {
    setStatus("Active", "ok");
  } else if (activeOrigin) {
    setStatus("No snapshot", "warn");
  } else {
    setStatus("No pgAdmin4 tab", "warn");
  }

  // Quick status indicators.
  $<HTMLSpanElement>("danger-status").textContent = settings.dangerInterceptEnabled ? "On" : "Off";
  $<HTMLSpanElement>("diag-status").textContent = settings.diagnosticsEnabled ? "On" : "Off";
  $<HTMLSpanElement>("editors").textContent = "—"; // (Could query content script; left as — to keep popup light.)

  function renderSnapshotMeta(id: string | null, snaps: SnapshotMeta[]) {
    const el = $<HTMLDivElement>("snapshot-meta");
    if (!id) {
      el.textContent = "";
      return;
    }
    const m = snaps.find((s) => s.snapshotId === id);
    if (!m) {
      el.textContent = "";
      return;
    }
    el.textContent = `${m.schemaCount} schemas · ${m.relationCount} relations · ${m.functionCount} functions`;
  }
}

init().catch((e) => {
  console.error("[pg4 popup] init failed:", e);
  setStatus(`Error: ${(e as Error).message}`, "err");
});

export {};
