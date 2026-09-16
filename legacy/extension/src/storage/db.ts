// IndexedDB storage layer (SPEC §5.5). Used by service worker & options page
// (extension origin, isolated from page origin). Content script reaches this via
// the service worker (chrome.runtime messaging); the worker holds the graph in memory.

import type { SchemaGraph } from "../types/schema-graph";
import type { SnapshotMeta, HostBinding, UsageStat, QueryHistoryEntry, Snippet, DdlWarning } from "../types/editor";
import { getUtf8ByteLength } from "../lib/payload-limits";

const DB_NAME = "pg4-smart-assist";
const DB_VERSION = 1;

export const STORES = {
  snapshots: "snapshots",
  schemaGraphs: "schemaGraphs",
  hostBindings: "hostBindings",
  usage: "usage",
  queryHistory: "queryHistory",
  snippets: "snippets",
  settings: "settings",
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

// Quota guards (SPEC §5.5)
export const MAX_HISTORY_ROWS = 20_000;
export const MAX_HISTORY_BYTES = 100 * 1024 * 1024;
export const MAX_TOTAL_DDL_BYTES = 250 * 1024 * 1024;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.snapshots)) {
        const s = db.createObjectStore(STORES.snapshots, { keyPath: "snapshotId" });
        s.createIndex("importedAt", "importedAt");
      }
      if (!db.objectStoreNames.contains(STORES.schemaGraphs)) {
        db.createObjectStore(STORES.schemaGraphs, { keyPath: "snapshotId" });
      }
      if (!db.objectStoreNames.contains(STORES.hostBindings)) {
        db.createObjectStore(STORES.hostBindings, { keyPath: "origin" });
      }
      if (!db.objectStoreNames.contains(STORES.usage)) {
        const s = db.createObjectStore(STORES.usage, { keyPath: ["snapshotId", "symbolKey"] });
        s.createIndex("snapshotId", "snapshotId");
      }
      if (!db.objectStoreNames.contains(STORES.queryHistory)) {
        const s = db.createObjectStore(STORES.queryHistory, { keyPath: "id", autoIncrement: true });
        s.createIndex("executedAt", "executedAt");
        s.createIndex("snapshotId", "snapshotId");
      }
      if (!db.objectStoreNames.contains(STORES.snippets)) {
        const s = db.createObjectStore(STORES.snippets, { keyPath: "id" });
        s.createIndex("category", "category");
      }
      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

/** Run a multi-store transaction; resolves when the transaction commits. */
function txMany(
  stores: StoreName[],
  mode: IDBTransactionMode,
  fn: (stores: Record<StoreName, IDBObjectStore>) => void
): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(stores as string[], mode);
        const storeMap = {} as Record<StoreName, IDBObjectStore>;
        for (const s of stores) storeMap[s] = t.objectStore(s);
        try {
          fn(storeMap);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export interface StoredSnapshot {
  snapshotId: string;
  meta: SnapshotMeta;
  /** compressed (stored as-is here; could be LZ-string compressed later) raw DDL */
  rawDdl: string;
}

export interface StoredSchemaGraph {
  snapshotId: string;
  graph: SchemaGraph;
  /** search index for fast completion (lowercased token -> keys) */
  index: SnapshotIndex;
}

export interface SnapshotIndex {
  /** lowercased relation name (without schema) -> "schema.relation" keys */
  relations: Record<string, string[]>;
  /** "schema.relation" -> lowercased column names */
  columns: Record<string, string[]>;
}

export interface StoredUsage {
  snapshotId: string;
  symbolKey: string;
  frequency: number;
  lastUsedAt: number;
}

// ---- Snapshots ----

export async function putSnapshot(snap: StoredSnapshot): Promise<void> {
  await tx(STORES.snapshots, "readwrite", (s) => s.put(snap));
}

export async function getSnapshotMeta(snapshotId: string): Promise<SnapshotMeta | null> {
  const row = (await tx(STORES.snapshots, "readonly", (s) => s.get(snapshotId))) as
    | (StoredSnapshot & { meta: SnapshotMeta })
    | undefined;
  return row?.meta ?? null;
}

/** Full snapshot row including the raw DDL (used for snapshot export). */
export async function getSnapshotRow(snapshotId: string): Promise<StoredSnapshot | null> {
  const row = (await tx(STORES.snapshots, "readonly", (s) => s.get(snapshotId))) as
    | StoredSnapshot
    | undefined;
  return row ?? null;
}

export async function listSnapshotMetas(): Promise<SnapshotMeta[]> {
  const all = (await tx(STORES.snapshots, "readonly", (s) => s.getAll())) as StoredSnapshot[];
  return all
    .map((r) => r.meta)
    .sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1));
}

export async function deleteSnapshot(snapshotId: string): Promise<void> {
  await txMany([STORES.snapshots, STORES.schemaGraphs, STORES.usage], "readwrite", (stores) => {
    stores[STORES.snapshots].delete(snapshotId);
    stores[STORES.schemaGraphs].delete(snapshotId);
    // delete usage rows for this snapshot
    const idx = stores[STORES.usage].index("snapshotId");
    idx.openCursor(IDBKeyRange.only(snapshotId)).onsuccess = (ev) => {
      const cursor = (ev.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  });
}

// ---- Schema graphs ----

export async function putSchemaGraph(g: StoredSchemaGraph): Promise<void> {
  await tx(STORES.schemaGraphs, "readwrite", (s) => s.put(g));
}

export async function getSchemaGraph(snapshotId: string): Promise<SchemaGraph | null> {
  const row = (await tx(STORES.schemaGraphs, "readonly", (s) => s.get(snapshotId))) as
    | StoredSchemaGraph
    | undefined;
  return row?.graph ?? null;
}

export async function getSchemaGraphWithIndex(snapshotId: string): Promise<StoredSchemaGraph | null> {
  const row = (await tx(STORES.schemaGraphs, "readonly", (s) => s.get(snapshotId))) as
    | StoredSchemaGraph
    | undefined;
  return row ?? null;
}

// ---- Host bindings ----

export async function setHostBinding(origin: string, snapshotId: string | null): Promise<void> {
  const binding: HostBinding = { origin, snapshotId, updatedAt: new Date().toISOString() };
  await tx(STORES.hostBindings, "readwrite", (s) => s.put(binding));
}

export async function deleteHostBinding(origin: string): Promise<void> {
  await tx(STORES.hostBindings, "readwrite", (s) => s.delete(origin));
}

export async function getHostBinding(origin: string): Promise<HostBinding | null> {
  const row = (await tx(STORES.hostBindings, "readonly", (s) => s.get(origin))) as HostBinding | undefined;
  return row ?? null;
}

export async function listHostBindings(): Promise<HostBinding[]> {
  return (await tx(STORES.hostBindings, "readonly", (s) => s.getAll())) as HostBinding[];
}

// ---- Usage ----

export async function recordUsage(snapshotId: string, symbolKey: string): Promise<void> {
  await txMany([STORES.usage], "readwrite", (stores) => {
    const key = [snapshotId, symbolKey] as unknown as IDBValidKey;
    const getReq = stores[STORES.usage].get(key);
    getReq.onsuccess = () => {
      const existing = getReq.result as StoredUsage | undefined;
      const now = Date.now();
      const row: StoredUsage = {
        snapshotId,
        symbolKey,
        frequency: (existing?.frequency ?? 0) + 1,
        lastUsedAt: now,
      };
      stores[STORES.usage].put(row);
    };
  });
}

export async function getUsageForSnapshot(snapshotId: string): Promise<UsageStat[]> {
  return new Promise((resolve, reject) => {
    openDb().then((db) => {
      const t = db.transaction(STORES.usage, "readonly");
      const idx = t.objectStore(STORES.usage).index("snapshotId");
      const req = idx.getAll(IDBKeyRange.only(snapshotId));
      req.onsuccess = () => resolve(req.result as UsageStat[]);
      req.onerror = () => reject(req.error);
    });
  });
}

// ---- Query history ----

export async function addQueryHistory(entry: Omit<QueryHistoryEntry, "id">): Promise<number> {
  const id = await new Promise<number>((resolve, reject) => {
    openDb().then((db) => {
      const t = db.transaction(STORES.queryHistory, "readwrite");
      const req = t.objectStore(STORES.queryHistory).add(entry as QueryHistoryEntry);
      req.onsuccess = () => resolve(req.result as number);
      req.onerror = () => reject(req.error);
    });
  });
  // Quota enforcement: prune oldest if over limits
  await pruneHistory();
  return id;
}

export async function listQueryHistory(opts: {
  limit?: number;
  snapshotId?: string;
  keyword?: string;
  from?: number;
  to?: number;
} = {}): Promise<QueryHistoryEntry[]> {
  return new Promise((resolve, reject) => {
    openDb().then((db) => {
      const t = db.transaction(STORES.queryHistory, "readonly");
      const store = t.objectStore(STORES.queryHistory);
      const idx = store.index("executedAt");
      const limit = opts.limit ?? 200;
      const out: QueryHistoryEntry[] = [];
      const req = idx.openCursor(null, "prev");
      req.onsuccess = () => {
        const cursor = req.result as IDBCursorWithValue | null;
        if (!cursor || out.length >= limit) {
          resolve(out);
          return;
        }
        const val = cursor.value as QueryHistoryEntry;
        const matchesSnapshot = !opts.snapshotId || val.snapshotId === opts.snapshotId;
        const matchesKeyword = !opts.keyword || val.sql.toLowerCase().includes(opts.keyword.toLowerCase());
        const matchesFrom = !opts.from || val.executedAt >= opts.from;
        const matchesTo = !opts.to || val.executedAt <= opts.to;
        if (matchesSnapshot && matchesKeyword && matchesFrom && matchesTo) {
          out.push(val);
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  });
}

export async function clearQueryHistory(): Promise<void> {
  await tx(STORES.queryHistory, "readwrite", (s) => s.clear());
}

async function pruneHistory(): Promise<void> {
  // Simple count-based prune to MAX_HISTORY_ROWS; bytes-based prune is best-effort.
  const count = await tx(STORES.queryHistory, "readonly", (s) => s.count());
  if (count <= MAX_HISTORY_ROWS) return;
  await new Promise<void>((resolve) => {
    openDb().then((db) => {
      const t = db.transaction(STORES.queryHistory, "readwrite");
      const idx = t.objectStore(STORES.queryHistory).index("executedAt");
      const toDelete = count - MAX_HISTORY_ROWS;
      let deleted = 0;
      const req = idx.openCursor();
      req.onsuccess = () => {
        const cursor = req.result as IDBCursorWithValue | null;
        if (!cursor || deleted >= toDelete) {
          resolve();
          return;
        }
        cursor.delete();
        deleted++;
        cursor.continue();
      };
    });
  });
}

// ---- Snippets ----

export async function listSnippets(): Promise<Snippet[]> {
  return (await tx(STORES.snippets, "readonly", (s) => s.getAll())) as Snippet[];
}

export async function putSnippet(snippet: Snippet): Promise<void> {
  await tx(STORES.snippets, "readwrite", (s) => s.put(snippet));
}

export async function deleteSnippet(id: string): Promise<void> {
  await tx(STORES.snippets, "readwrite", (s) => s.delete(id));
}

// ---- Settings ----

export async function getSetting<T>(key: string): Promise<T | null> {
  const row = (await tx(STORES.settings, "readonly", (s) => s.get(key))) as { key: string; value: T } | undefined;
  return (row?.value as T) ?? null;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await tx(STORES.settings, "readwrite", (s) => s.put({ key, value }));
}

// ---- Stats / diagnostics ----

export async function estimateStorage(): Promise<{ usage: number; quota: number }> {
  if (navigator.storage?.estimate) {
    const est = await navigator.storage.estimate();
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  }
  return { usage: 0, quota: 0 };
}

export async function getAllSnapshotRawSizes(): Promise<number> {
  const all = (await tx(STORES.snapshots, "readonly", (s) => s.getAll())) as StoredSnapshot[];
  return all.reduce((sum, s) => sum + getUtf8ByteLength(s.rawDdl), 0);
}

export async function exportAllData(): Promise<{
  snapshots: StoredSnapshot[];
  graphs: StoredSchemaGraph[];
  bindings: HostBinding[];
  usage: UsageStat[];
  history: QueryHistoryEntry[];
  snippets: Snippet[];
}> {
  const [snapshots, graphs, bindings, usage, history, snippets] = await Promise.all([
    tx(STORES.snapshots, "readonly", (s) => s.getAll()) as Promise<StoredSnapshot[]>,
    tx(STORES.schemaGraphs, "readonly", (s) => s.getAll()) as Promise<StoredSchemaGraph[]>,
    tx(STORES.hostBindings, "readonly", (s) => s.getAll()) as Promise<HostBinding[]>,
    tx(STORES.usage, "readonly", (s) => s.getAll()) as Promise<UsageStat[]>,
    tx(STORES.queryHistory, "readonly", (s) => s.getAll()) as Promise<QueryHistoryEntry[]>,
    tx(STORES.snippets, "readonly", (s) => s.getAll()) as Promise<Snippet[]>,
  ]);
  return { snapshots, graphs, bindings, usage, history, snippets };
}

// Re-export warnings type for convenience
export type { DdlWarning };
