// Small config storage via chrome.storage.local (SPEC §3.1 table: host allowlist, theme, active snapshot).
// These are tiny values that don't belong in IndexedDB.

const KEYS = {
  hostAllowlist: "pg4.hostAllowlist",
  activeSnapshotByOrigin: "pg4.activeSnapshotByOrigin",
  settings: "pg4.settings",
  completionTriggerMode: "pg4.completionTriggerMode",
  pasteMode: "pg4.pasteMode",
  diagnosticsEnabled: "pg4.diagnosticsEnabled",
  dangerInterceptEnabled: "pg4.dangerInterceptEnabled",
} as const;

export interface Pg4Settings {
  /** "auto" = show our menu when native menu open; "manual" = only Ctrl+Space */
  completionTriggerMode: "auto" | "manual";
  /** "on" | "notify" | "off" */
  pasteMode: "on" | "notify" | "off";
  diagnosticsEnabled: boolean;
  dangerInterceptEnabled: boolean;
  /** maximum candidates rendered initially */
  maxCandidates: number;
  /** force-trigger shortcut (e.g. "Ctrl+Space"); macOS override */
  completionShortcut: string;
  historyRetentionDays: number;
  /** first-run flags */
  smartPasteHintDismissed: boolean;
}

export const DEFAULT_SETTINGS: Pg4Settings = {
  completionTriggerMode: "auto",
  pasteMode: "on",
  diagnosticsEnabled: true,
  dangerInterceptEnabled: true,
  maxCandidates: 50,
  completionShortcut: "Ctrl+Space",
  historyRetentionDays: 90,
  smartPasteHintDismissed: false,
};

export async function getSettings(): Promise<Pg4Settings> {
  const raw = await chrome.storage.local.get(KEYS.settings);
  const v = raw[KEYS.settings] as Partial<Pg4Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...(v ?? {}) };
}

export async function setSettings(patch: Partial<Pg4Settings>): Promise<Pg4Settings> {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [KEYS.settings]: next });
  return next;
}

export async function getHostAllowlist(): Promise<string[]> {
  const raw = await chrome.storage.local.get(KEYS.hostAllowlist);
  return (raw[KEYS.hostAllowlist] as string[] | undefined) ?? [];
}

export async function setHostAllowlist(hosts: string[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.hostAllowlist]: hosts });
}

export async function getActiveSnapshotByOrigin(origin: string): Promise<string | null> {
  const raw = await chrome.storage.local.get(KEYS.activeSnapshotByOrigin);
  const map = (raw[KEYS.activeSnapshotByOrigin] as Record<string, string> | undefined) ?? {};
  return map[origin] ?? null;
}

export async function setActiveSnapshotByOrigin(origin: string, snapshotId: string | null): Promise<void> {
  const raw = await chrome.storage.local.get(KEYS.activeSnapshotByOrigin);
  const map = (raw[KEYS.activeSnapshotByOrigin] as Record<string, string> | undefined) ?? {};
  if (snapshotId === null) delete map[origin];
  else map[origin] = snapshotId;
  await chrome.storage.local.set({ [KEYS.activeSnapshotByOrigin]: map });
}

export const StorageKeys = KEYS;
