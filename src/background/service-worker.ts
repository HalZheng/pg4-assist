// Background service worker (SPEC §3.2). Single source of truth for:
//   - Snapshot persistence (DDL import / parse / delete / export)
//   - Host binding (origin -> snapshotId)
//   - Active context for content scripts (graph + usage + snippets loaded for a given origin)
//   - Settings changes broadcast
//   - History + usage writes
//   - Snippet CRUD
//
// The service worker itself does NOT parse DDL synchronously — it spawns a parser-worker via
// chrome.runtime.getURL and forwards parse requests. This keeps service worker startup cheap
// and isolates long-running work.

import {
  getSettings,
  setSettings,
  getHostAllowlist,
  setHostAllowlist,
  getActiveSnapshotByOrigin,
  setActiveSnapshotByOrigin,
  DEFAULT_SETTINGS,
  type Pg4Settings,
} from "../storage/chrome-storage";
import {
  putSnapshot,
  listSnapshotMetas,
  deleteSnapshot,
  getSchemaGraph,
  getSchemaGraphWithIndex,
  putSchemaGraph,
  setHostBinding,
  deleteHostBinding,
  listHostBindings,
  recordUsage,
  getUsageForSnapshot,
  addQueryHistory,
  listQueryHistory,
  clearQueryHistory,
  listSnippets,
  putSnippet,
  deleteSnippet,
  estimateStorage,
  exportAllData,
  getAllSnapshotRawSizes,
  type StoredSnapshot,
  type StoredSchemaGraph,
  getSnapshotRow,
} from "../storage/db";
import { parseDdl, DDL_PARSER_VERSION } from "../lib/ddl-parser";
import { buildIndex } from "../lib/schema-index";
import { assertUtf8ByteLimit, MAX_DDL_IMPORT_BYTES } from "../lib/payload-limits";
import type { SchemaGraph } from "../types/schema-graph";
import type { QueryHistoryEntry, Snippet, UsageStat, SnapshotMeta, HostBinding } from "../types/editor";

// ---------------------------------------------------------------------------
// In-memory caches (per service-worker lifecycle; MV3 may kill the SW at any time,
// so all caches must be repopulatable from IndexedDB on demand).
// ---------------------------------------------------------------------------

const settingsCache: { value: Pg4Settings | null } = { value: null };
const graphCache = new Map<string, SchemaGraph>(); // snapshotId -> graph
const DEFAULT_HOST_ORIGIN = "https://sfs-pg-dev.acscloud.net";
const DEFAULT_HOSTS_SEEDED_KEY = "pg4.defaultHostsSeeded.v1";

async function getSettingsCached(): Promise<Pg4Settings> {
  if (!settingsCache.value) settingsCache.value = await getSettings();
  return settingsCache.value;
}

async function getGraphCached(snapshotId: string): Promise<SchemaGraph | null> {
  if (graphCache.has(snapshotId)) return graphCache.get(snapshotId)!;
  const g = await getSchemaGraph(snapshotId);
  if (g) {
    graphCache.set(snapshotId, g);
    return g;
  }
  return null;
}

async function ensureDefaultHostBinding(): Promise<void> {
  const seeded = await chrome.storage.local.get(DEFAULT_HOSTS_SEEDED_KEY);
  if (seeded[DEFAULT_HOSTS_SEEDED_KEY] === true) return;

  const bindings = await listHostBindings();
  if (!bindings.some((binding) => binding.origin === DEFAULT_HOST_ORIGIN)) {
    await setHostBinding(DEFAULT_HOST_ORIGIN, null);
  }
  await chrome.storage.local.set({ [DEFAULT_HOSTS_SEEDED_KEY]: true });
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as { type?: string };
  // Return true to indicate we'll respond asynchronously.
  void (async () => {
    try {
      const result = await handleMessage(m, sender);
      sendResponse(result);
    } catch (e: any) {
      sendResponse({ __error: true, message: e?.message ?? String(e) });
    }
  })();
  return true;
});

async function handleMessage(msg: { type?: string }, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    // --- Content script ---
    case "pg4:get-active-context": {
      const { origin } = msg as { origin: string };
      const snapshotId = await getActiveSnapshotByOrigin(origin);
      let graph: SchemaGraph | null = null;
      let usage: UsageStat[] = [];
      if (snapshotId) {
        graph = await getGraphCached(snapshotId);
        usage = await getUsageForSnapshot(snapshotId);
      }
      const snippets = await listSnippets();
      return { snapshotId, graph, usage, snippets };
    }
    case "pg4:add-history": {
      const { entry } = msg as { entry: Omit<QueryHistoryEntry, "id"> };
      await addQueryHistory(entry);
      return { ok: true };
    }
    case "pg4:record-usage": {
      const { symbolKey, snapshotId } = msg as { symbolKey: string; snapshotId: string };
      if (snapshotId && symbolKey) await recordUsage(snapshotId, symbolKey);
      return { ok: true };
    }
    case "pg4:list-snippets": {
      return await listSnippets();
    }
    case "pg4:focus-trigger": {
      // Forward to the active tab's content script (used by popup button).
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        try {
          await chrome.tabs.sendMessage(tab.id, { type: "pg4:focus-trigger" });
        } catch {
          /* tab may not have content script */
        }
      }
      return { ok: true };
    }

    // --- Options page ---
    case "pg4:import-snapshot": {
      const { displayName, sourceFileName, rawDdl } = msg as {
        displayName: string;
        sourceFileName: string;
        rawDdl: string;
      };
      if (!displayName.trim() || !sourceFileName.trim() || typeof rawDdl !== "string") {
        throw new Error("Snapshot name, source file name, and DDL content are required.");
      }
      assertUtf8ByteLimit(rawDdl, MAX_DDL_IMPORT_BYTES, "DDL import");
      const existingDdlBytes = await getAllSnapshotRawSizes();
      if (existingDdlBytes + new TextEncoder().encode(rawDdl).byteLength > 250 * 1024 * 1024) {
        throw new Error("Import would exceed the 250 MB local DDL storage limit.");
      }
      const snapshotId = `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const result = parseDdl(rawDdl, snapshotId, displayName, sourceFileName);
      const index = buildIndex(result.graph);
      const meta: SnapshotMeta = {
        snapshotId,
        displayName,
        sourceFileName,
        importedAt: new Date().toISOString(),
        parserVersion: DDL_PARSER_VERSION,
        schemaCount: Object.keys(result.graph.schemas).length,
        relationCount: Object.values(result.graph.schemas).reduce(
          (n, s) => n + Object.keys(s.relations).length,
          0
        ),
        functionCount: result.graph.functions.length,
        warningCount: result.warnings.length,
        rawSizeBytes: rawDdl.length,
      };
      const stored: StoredSnapshot = { snapshotId, meta, rawDdl };
      await putSnapshot(stored);
      await putSchemaGraph({ snapshotId, graph: result.graph, index });
      // Cache graph.
      graphCache.set(snapshotId, result.graph);
      return { snapshotId, meta, warnings: result.warnings };
    }
    case "pg4:list-snapshots": {
      return await listSnapshotMetas();
    }
    case "pg4:export-snapshot": {
      const { snapshotId } = msg as { snapshotId: string };
      const row = await getSnapshotRow(snapshotId);
      if (!row) return { __error: true, message: "snapshot not found" };
      const graph = await getSchemaGraph(snapshotId);
      const usage = await getUsageForSnapshot(snapshotId);
      return { snapshot: row, graph, usage };
    }
    case "pg4:delete-snapshot": {
      const { snapshotId } = msg as { snapshotId: string };
      // First clear any host bindings referencing this snapshot.
      const bindings = await listHostBindings();
      for (const b of bindings) {
        if (b.snapshotId === snapshotId) {
          await setHostBinding(b.origin, null);
          await setActiveSnapshotByOrigin(b.origin, null);
        }
      }
      await deleteSnapshot(snapshotId);
      graphCache.delete(snapshotId);
      // Broadcast snapshot change to all tabs.
      await broadcastToAllTabs({ type: "pg4:snapshot-changed" });
      return { ok: true };
    }
    case "pg4:set-host-binding": {
      const { origin, snapshotId } = msg as { origin: string; snapshotId: string | null };
      await setHostBinding(origin, snapshotId);
      await setActiveSnapshotByOrigin(origin, snapshotId);
      // Notify all tabs with matching origin to reload.
      await broadcastToOrigin(origin, { type: "pg4:snapshot-changed" });
      return { ok: true };
    }
    case "pg4:delete-host-binding": {
      const { origin } = msg as { origin: string };
      await deleteHostBinding(origin);
      await setActiveSnapshotByOrigin(origin, null);
      await broadcastToOrigin(origin, { type: "pg4:snapshot-changed" });
      return { ok: true };
    }
    case "pg4:list-host-bindings": {
      await ensureDefaultHostBinding();
      return await listHostBindings();
    }
    case "pg4:get-settings": {
      return await getSettingsCached();
    }
    case "pg4:set-settings": {
      const { patch } = msg as { patch: Partial<Pg4Settings> };
      const next = await setSettings(patch);
      settingsCache.value = next;
      await broadcastToAllTabs({ type: "pg4:settings-changed" });
      return next;
    }
    case "pg4:save-snippet": {
      const { snippet } = msg as { snippet: Snippet };
      await putSnippet(snippet);
      await broadcastToAllTabs({ type: "pg4:snippets-changed" });
      return { ok: true };
    }
    case "pg4:delete-snippet": {
      const { id } = msg as { id: string };
      await deleteSnippet(id);
      await broadcastToAllTabs({ type: "pg4:snippets-changed" });
      return { ok: true };
    }
    case "pg4:list-history": {
      const opts = (msg as { opts?: Parameters<typeof listQueryHistory>[0] }).opts ?? {};
      return await listQueryHistory(opts);
    }
    case "pg4:clear-history": {
      await clearQueryHistory();
      return { ok: true };
    }
    case "pg4:export-all": {
      return await exportAllData();
    }
    case "pg4:storage-stats": {
      const [est, metas, totalRaw] = await Promise.all([
        estimateStorage(),
        listSnapshotMetas(),
        getAllSnapshotRawSizes(),
      ]);
      return {
        usage: est.usage,
        quota: est.quota,
        totalRawDdlBytes: totalRaw,
        snapshots: metas.map((m) => ({ id: m.snapshotId, displayName: m.displayName, rawSizeBytes: m.rawSizeBytes })),
      };
    }
    case "pg4:get-host-allowlist": {
      return await getHostAllowlist();
    }
    case "pg4:set-host-allowlist": {
      const { hosts } = msg as { hosts: string[] };
      await setHostAllowlist(hosts);
      return { ok: true };
    }
    case "pg4:request-host-permission": {
      const { origin } = msg as { origin: string };
      // Convert origin (e.g. https://pgadmin.example.com) to a URL pattern.
      const pattern = origin.endsWith("/") ? `${origin}*` : `${origin}/*`;
      try {
        const granted = await chrome.permissions.request({ origins: [pattern] });
        return { granted };
      } catch (e: any) {
        return { granted: false, error: e?.message ?? String(e) };
      }
    }
    case "pg4:ping": {
      return { ok: true, version: chrome.runtime.getManifest().version };
    }
    case "pg4:get-graph": {
      const { snapshotId } = msg as { snapshotId: string };
      return await getGraphCached(snapshotId);
    }
    case "pg4:get-graph-with-index": {
      const { snapshotId } = msg as { snapshotId: string };
      return await getSchemaGraphWithIndex(snapshotId);
    }
    default: {
      return { __error: true, message: `unknown message type ${msg.type ?? ""}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------

async function broadcastToAllTabs(message: unknown): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id) return;
      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch {
        /* tab may not have content script — ignore */
      }
    })
  );
}

async function broadcastToOrigin(origin: string, message: unknown): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id || !tab.url) return;
      try {
        const u = new URL(tab.url);
        if (u.origin === origin) {
          await chrome.tabs.sendMessage(tab.id, message);
        }
      } catch {
        /* invalid URL — ignore */
      }
    })
  );
}

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  // Initialize default settings on first install.
  await getSettingsCached();
  await ensureDefaultHostBinding();
  if (details.reason === "install") {
    console.info("[pg4] installed; default settings initialized.");
  }
});

// MV3 service worker can be killed at any time; we keep startup light. Caches are lazy.
// On wakeup, chrome.runtime.onMessage fires when a content script / popup / options page sends
// a message — handlers re-populate caches as needed.

// Silence unused imports in some build configurations.
void DEFAULT_SETTINGS;

export {};
