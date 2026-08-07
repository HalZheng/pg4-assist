// Completion ranker (SPEC §6.5). Implements the weighted score:
//   S = 0.40M + 0.20R + 0.15F + 0.10L + 0.10K + 0.05D
// Cold start (no usage data) uses only M + K + D (no randomness).
// Ties broken by context-kind priority then stable alphabetical.

import type { CompletionItem, CompletionItemKind } from "../types/completion";
import type { UsageStat } from "../types/editor";

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENCY_WINDOW_DAYS = 30;

/** Internal candidate carrying usage/baseType metadata for scoring. */
export interface ScoredCandidate extends CompletionItem {
  /** symbol key for usage lookup, e.g. "public.orders.id" or "public.count" */
  usageKey?: string;
  /** normalized base type for D scoring */
  baseType?: string;
}

export interface RankInputs {
  /** current prefix being typed */
  prefix: string;
  usage: Map<string, UsageStat>; // keyed "snapshotId|symbolKey"
  snapshotId: string;
  localUsage: Map<string, number>; // keyed symbolKey
  /** keys of relations/columns considered "key" in the current context */
  keySymbolKeys?: Set<string>;
  /** expected base types by context, for D scoring */
  expectedBaseTypes?: Set<string>;
}

export function computeScore(item: ScoredCandidate, inputs: RankInputs): number {
  const M = prefixMatchScore(inputs.prefix, item.filterText || item.label);
  const R = recencyScore(item, inputs);
  const F = frequencyScore(item, inputs);
  const L = localScore(item, inputs);
  const K = keynessScore(item, inputs);
  const D = contextMatchScore(item, inputs);
  return 0.4 * M + 0.2 * R + 0.15 * F + 0.1 * L + 0.1 * K + 0.05 * D;
}

/** Score with an explicit prefix (convenience). */
export function scoreWithPrefix(prefix: string, item: ScoredCandidate, inputs: RankInputs): number {
  return computeScore(item, { ...inputs, prefix });
}

export function prefixMatchScore(prefix: string, label: string): number {
  if (!prefix) return 0.5;
  const p = prefix.toLowerCase();
  const l = label.toLowerCase();
  if (l === p) return 1.0;
  if (l.startsWith(p)) return 0.9;
  const segments = label.split(/(?=[A-Z])|[_\s.]+/).filter(Boolean);
  if (segments.some((s) => s.toLowerCase().startsWith(p))) return 0.7;
  if (fuzzyContains(l, p)) return 0.4;
  return 0;
}

function fuzzyContains(label: string, prefix: string): boolean {
  let i = 0;
  for (const ch of label) {
    if (ch === prefix[i]) i++;
    if (i >= prefix.length) return true;
  }
  return i >= prefix.length;
}

function lookupStat(item: ScoredCandidate, inputs: RankInputs): UsageStat | undefined {
  if (!item.usageKey) return undefined;
  return inputs.usage.get(`${inputs.snapshotId}|${item.usageKey.toLowerCase()}`);
}

function recencyScore(item: ScoredCandidate, inputs: RankInputs): number {
  const stat = lookupStat(item, inputs);
  if (!stat || !stat.lastUsedAt) return 0;
  const ageDays = (Date.now() - stat.lastUsedAt) / DAY_MS;
  if (ageDays >= RECENCY_WINDOW_DAYS) return 0;
  return 1 - ageDays / RECENCY_WINDOW_DAYS;
}

function frequencyScore(item: ScoredCandidate, inputs: RankInputs): number {
  let maxFreq = 0;
  for (const s of inputs.usage.values()) if (s.frequency > maxFreq) maxFreq = s.frequency;
  if (maxFreq === 0) return 0;
  const stat = lookupStat(item, inputs);
  if (!stat) return 0;
  return stat.frequency / maxFreq;
}

function localScore(item: ScoredCandidate, inputs: RankInputs): number {
  let maxLocal = 0;
  for (const v of inputs.localUsage.values()) if (v > maxLocal) maxLocal = v;
  if (maxLocal === 0) return 0;
  if (!item.usageKey) return 0;
  const v = inputs.localUsage.get(item.usageKey.toLowerCase()) ?? 0;
  return v / maxLocal;
}

function keynessScore(item: ScoredCandidate, inputs: RankInputs): number {
  if (!inputs.keySymbolKeys || inputs.keySymbolKeys.size === 0 || !item.usageKey) return 0;
  return inputs.keySymbolKeys.has(item.usageKey.toLowerCase()) ? 1 : 0;
}

function contextMatchScore(item: ScoredCandidate, inputs: RankInputs): number {
  if (!inputs.expectedBaseTypes || inputs.expectedBaseTypes.size === 0) return 0.5;
  if (!item.baseType) return 0.5;
  return inputs.expectedBaseTypes.has(normalizeBase(item.baseType)) ? 1 : 0;
}

function normalizeBase(t: string): string {
  return t.toLowerCase().replace(/\[\]$/, "").replace(/\s*\([^)]*\)/g, "").trim();
}

export function sortItems<T extends CompletionItem>(items: T[]): T[] {
  const priority: Record<CompletionItemKind, number> = {
    table: 1,
    view: 1,
    schema: 1,
    cte: 1,
    column: 2,
    function: 3,
    keyword: 4,
    snippet: 5,
    "jsonb-path": 1,
  };
  return [...items].sort((a, b) => {
    if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
    const pa = priority[a.kind] ?? 9;
    const pb = priority[b.kind] ?? 9;
    if (pa !== pb) return pa - pb;
    return a.label.toLowerCase() < b.label.toLowerCase() ? -1 : a.label.toLowerCase() > b.label.toLowerCase() ? 1 : 0;
  });
}

/** Build a usage map keyed by `snapshotId|symbolKey` for fast lookup. */
export function buildUsageLookup(stats: UsageStat[]): Map<string, UsageStat> {
  const m = new Map<string, UsageStat>();
  for (const s of stats) m.set(`${s.snapshotId}|${s.symbolKey.toLowerCase()}`, s);
  return m;
}
