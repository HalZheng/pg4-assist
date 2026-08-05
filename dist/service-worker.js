// src/storage/chrome-storage.ts
var KEYS = {
  hostAllowlist: "pg4.hostAllowlist",
  activeSnapshotByOrigin: "pg4.activeSnapshotByOrigin",
  settings: "pg4.settings",
  completionTriggerMode: "pg4.completionTriggerMode",
  pasteMode: "pg4.pasteMode",
  diagnosticsEnabled: "pg4.diagnosticsEnabled",
  dangerInterceptEnabled: "pg4.dangerInterceptEnabled"
};
var DEFAULT_SETTINGS = {
  completionTriggerMode: "auto",
  pasteMode: "on",
  diagnosticsEnabled: true,
  dangerInterceptEnabled: true,
  maxCandidates: 50,
  completionShortcut: "Ctrl+Space",
  historyRetentionDays: 90,
  smartPasteHintDismissed: false
};
async function getSettings() {
  const raw = await chrome.storage.local.get(KEYS.settings);
  const v = raw[KEYS.settings];
  return { ...DEFAULT_SETTINGS, ...v ?? {} };
}
async function setSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [KEYS.settings]: next });
  return next;
}
async function getHostAllowlist() {
  const raw = await chrome.storage.local.get(KEYS.hostAllowlist);
  return raw[KEYS.hostAllowlist] ?? [];
}
async function setHostAllowlist(hosts) {
  await chrome.storage.local.set({ [KEYS.hostAllowlist]: hosts });
}
async function getActiveSnapshotByOrigin(origin) {
  const raw = await chrome.storage.local.get(KEYS.activeSnapshotByOrigin);
  const map = raw[KEYS.activeSnapshotByOrigin] ?? {};
  return map[origin] ?? null;
}
async function setActiveSnapshotByOrigin(origin, snapshotId) {
  const raw = await chrome.storage.local.get(KEYS.activeSnapshotByOrigin);
  const map = raw[KEYS.activeSnapshotByOrigin] ?? {};
  if (snapshotId === null) delete map[origin];
  else map[origin] = snapshotId;
  await chrome.storage.local.set({ [KEYS.activeSnapshotByOrigin]: map });
}

// src/storage/db.ts
var DB_NAME = "pg4-smart-assist";
var DB_VERSION = 1;
var STORES = {
  snapshots: "snapshots",
  schemaGraphs: "schemaGraphs",
  hostBindings: "hostBindings",
  usage: "usage",
  queryHistory: "queryHistory",
  snippets: "snippets",
  settings: "settings"
};
var MAX_HISTORY_ROWS = 2e4;
var MAX_HISTORY_BYTES = 100 * 1024 * 1024;
var MAX_TOTAL_DDL_BYTES = 250 * 1024 * 1024;
var dbPromise = null;
function openDb() {
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
function tx(store, mode, fn) {
  return openDb().then(
    (db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    })
  );
}
function txMany(stores, mode, fn) {
  return openDb().then(
    (db) => new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      const storeMap = {};
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
async function putSnapshot(snap) {
  await tx(STORES.snapshots, "readwrite", (s) => s.put(snap));
}
async function getSnapshotRow(snapshotId) {
  const row = await tx(STORES.snapshots, "readonly", (s) => s.get(snapshotId));
  return row ?? null;
}
async function listSnapshotMetas() {
  const all = await tx(STORES.snapshots, "readonly", (s) => s.getAll());
  return all.map((r) => r.meta).sort((a, b) => a.importedAt < b.importedAt ? 1 : -1);
}
async function deleteSnapshot(snapshotId) {
  await txMany([STORES.snapshots, STORES.schemaGraphs, STORES.usage], "readwrite", (stores) => {
    stores[STORES.snapshots].delete(snapshotId);
    stores[STORES.schemaGraphs].delete(snapshotId);
    const idx = stores[STORES.usage].index("snapshotId");
    idx.openCursor(IDBKeyRange.only(snapshotId)).onsuccess = (ev) => {
      const cursor = ev.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  });
}
async function putSchemaGraph(g) {
  await tx(STORES.schemaGraphs, "readwrite", (s) => s.put(g));
}
async function getSchemaGraph(snapshotId) {
  const row = await tx(STORES.schemaGraphs, "readonly", (s) => s.get(snapshotId));
  return row?.graph ?? null;
}
async function getSchemaGraphWithIndex(snapshotId) {
  const row = await tx(STORES.schemaGraphs, "readonly", (s) => s.get(snapshotId));
  return row ?? null;
}
async function setHostBinding(origin, snapshotId) {
  const binding = { origin, snapshotId, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  await tx(STORES.hostBindings, "readwrite", (s) => s.put(binding));
}
async function listHostBindings() {
  return await tx(STORES.hostBindings, "readonly", (s) => s.getAll());
}
async function recordUsage(snapshotId, symbolKey) {
  await txMany([STORES.usage], "readwrite", (stores) => {
    const key = [snapshotId, symbolKey];
    const getReq = stores[STORES.usage].get(key);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      const now = Date.now();
      const row = {
        snapshotId,
        symbolKey,
        frequency: (existing?.frequency ?? 0) + 1,
        lastUsedAt: now
      };
      stores[STORES.usage].put(row);
    };
  });
}
async function getUsageForSnapshot(snapshotId) {
  return new Promise((resolve, reject) => {
    openDb().then((db) => {
      const t = db.transaction(STORES.usage, "readonly");
      const idx = t.objectStore(STORES.usage).index("snapshotId");
      const req = idx.getAll(IDBKeyRange.only(snapshotId));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  });
}
async function addQueryHistory(entry) {
  const id = await new Promise((resolve, reject) => {
    openDb().then((db) => {
      const t = db.transaction(STORES.queryHistory, "readwrite");
      const req = t.objectStore(STORES.queryHistory).add(entry);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  });
  await pruneHistory();
  return id;
}
async function listQueryHistory(opts = {}) {
  return new Promise((resolve, reject) => {
    openDb().then((db) => {
      const t = db.transaction(STORES.queryHistory, "readonly");
      const store = t.objectStore(STORES.queryHistory);
      const idx = store.index("executedAt");
      const limit = opts.limit ?? 200;
      const out = [];
      const req = idx.openCursor(null, "prev");
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || out.length >= limit) {
          resolve(out);
          return;
        }
        const val = cursor.value;
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
async function clearQueryHistory() {
  await tx(STORES.queryHistory, "readwrite", (s) => s.clear());
}
async function pruneHistory() {
  const count = await tx(STORES.queryHistory, "readonly", (s) => s.count());
  if (count <= MAX_HISTORY_ROWS) return;
  await new Promise((resolve) => {
    openDb().then((db) => {
      const t = db.transaction(STORES.queryHistory, "readwrite");
      const idx = t.objectStore(STORES.queryHistory).index("executedAt");
      const toDelete = count - MAX_HISTORY_ROWS;
      let deleted = 0;
      const req = idx.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
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
async function listSnippets() {
  return await tx(STORES.snippets, "readonly", (s) => s.getAll());
}
async function putSnippet(snippet) {
  await tx(STORES.snippets, "readwrite", (s) => s.put(snippet));
}
async function deleteSnippet(id) {
  await tx(STORES.snippets, "readwrite", (s) => s.delete(id));
}
async function estimateStorage() {
  if (navigator.storage?.estimate) {
    const est = await navigator.storage.estimate();
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  }
  return { usage: 0, quota: 0 };
}
async function getAllSnapshotRawSizes() {
  const all = await tx(STORES.snapshots, "readonly", (s) => s.getAll());
  return all.reduce((sum, s) => sum + s.rawDdl.length, 0);
}
async function exportAllData() {
  const [snapshots, graphs, bindings, usage, history, snippets] = await Promise.all([
    tx(STORES.snapshots, "readonly", (s) => s.getAll()),
    tx(STORES.schemaGraphs, "readonly", (s) => s.getAll()),
    tx(STORES.hostBindings, "readonly", (s) => s.getAll()),
    tx(STORES.usage, "readonly", (s) => s.getAll()),
    tx(STORES.queryHistory, "readonly", (s) => s.getAll()),
    tx(STORES.snippets, "readonly", (s) => s.getAll())
  ]);
  return { snapshots, graphs, bindings, usage, history, snippets };
}

// src/lib/sql-tokenizer.ts
var KEYWORD_CHAR_RE = /[A-Za-z0-9_]/;
var IDENT_START_RE = /[A-Za-z_]/;
var DIGIT_RE = /[0-9]/;
var WHITESPACE_RE = /\s/;
var PUNCTUATION = /* @__PURE__ */ new Set(["(", ")", ",", ";", ".", "[", "]", ":", "*"]);
function tokenize(sql) {
  const tokens = [];
  let i = 0;
  let line = 1;
  const n = sql.length;
  const push = (t) => tokens.push(t);
  while (i < n) {
    const ch = sql[i];
    if (ch === "\n") {
      push({ type: "newline", text: "\n", start: i, end: i + 1, line });
      line++;
      i++;
      continue;
    }
    if (WHITESPACE_RE.test(ch)) {
      let j = i + 1;
      while (j < n && WHITESPACE_RE.test(sql[j]) && sql[j] !== "\n") j++;
      push({ type: "whitespace", text: sql.slice(i, j), start: i, end: j, line });
      i = j;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      let j = i + 2;
      while (j < n && sql[j] !== "\n") j++;
      push({ type: "comment-line", text: sql.slice(i, j), start: i, end: j, line });
      i = j;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      let j = i + 2;
      let depth = 1;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else if (sql[j] === "\n") {
          line++;
          j++;
        } else {
          j++;
        }
      }
      push({ type: "comment-block", text: sql.slice(i, j), start: i, end: j, line });
      i = j;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        if (sql[j] === "\n") line++;
        j++;
      }
      const text = sql.slice(i, j);
      const value = text.slice(1, -1).replace(/''/g, "'");
      push({ type: "string", text, start: i, end: j, line, value });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        if (sql[j] === "\n") line++;
        j++;
      }
      const text = sql.slice(i, j);
      const value = text.slice(1, -1).replace(/""/g, '"');
      push({ type: "quoted-identifier", text, start: i, end: j, line, value });
      i = j;
      continue;
    }
    if (ch === "$") {
      const tagMatch = sql.slice(i).match(/^\$[A-Za-z_0-9]*\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const closeIdx = sql.indexOf(tag, i + tag.length);
        const j = closeIdx < 0 ? n : closeIdx + tag.length;
        for (let k = i; k < j; k++) if (sql[k] === "\n") line++;
        push({ type: "dollar-quote", text: sql.slice(i, j), start: i, end: j, line, value: tag });
        i = j;
        continue;
      }
    }
    if (DIGIT_RE.test(ch) || ch === "." && DIGIT_RE.test(sql[i + 1] ?? "")) {
      let j = i;
      if (ch === "0" && (sql[i + 1] === "x" || sql[i + 1] === "X")) {
        j += 2;
        while (j < n && /[0-9a-fA-F]/.test(sql[j])) j++;
      } else {
        while (j < n && (DIGIT_RE.test(sql[j]) || sql[j] === ".")) j++;
        if (sql[j] === "e" || sql[j] === "E") {
          j++;
          if (sql[j] === "+" || sql[j] === "-") j++;
          while (j < n && DIGIT_RE.test(sql[j])) j++;
        }
      }
      push({ type: "number", text: sql.slice(i, j), start: i, end: j, line });
      i = j;
      continue;
    }
    if (IDENT_START_RE.test(ch)) {
      let j = i + 1;
      while (j < n && KEYWORD_CHAR_RE.test(sql[j])) j++;
      const text = sql.slice(i, j);
      const upper = text.toUpperCase();
      const isKeyword = KEYWORDS.has(upper);
      push({
        type: isKeyword ? "keyword" : "identifier",
        text,
        start: i,
        end: j,
        line,
        value: text
      });
      i = j;
      continue;
    }
    if (ch === "-" && sql[i + 1] === ">") {
      let len = 2;
      if (sql[i + 2] === ">") len = 3;
      push({ type: "operator", text: sql.slice(i, i + len), start: i, end: i + len, line });
      i += len;
      continue;
    }
    if (ch === "#" && sql[i + 1] === ">") {
      let len = 2;
      if (sql[i + 2] === ">") len = 3;
      push({ type: "operator", text: sql.slice(i, i + len), start: i, end: i + len, line });
      i += len;
      continue;
    }
    if ("<>!=".includes(ch)) {
      let len = 1;
      if (sql[i + 1] === "=") len = 2;
      if (ch === "<" && sql[i + 1] === ">" || ch === "!" && sql[i + 1] === "=") len = 2;
      if (ch === "|" && sql[i + 1] === "|") len = 2;
      push({ type: "operator", text: sql.slice(i, i + len), start: i, end: i + len, line });
      i += len;
      continue;
    }
    if (ch === "|" && sql[i + 1] === "|") {
      push({ type: "operator", text: "||", start: i, end: i + 2, line });
      i += 2;
      continue;
    }
    if (ch === ":" && sql[i + 1] === ":") {
      push({ type: "operator", text: "::", start: i, end: i + 2, line });
      i += 2;
      continue;
    }
    if (PUNCTUATION.has(ch)) {
      push({ type: "punctuation", text: ch, start: i, end: i + 1, line });
      i++;
      continue;
    }
    if ("+-*/%<>=~&|^@?".includes(ch)) {
      push({ type: "operator", text: ch, start: i, end: i + 1, line });
      i++;
      continue;
    }
    push({ type: "punctuation", text: ch, start: i, end: i + 1, line });
    i++;
  }
  push({ type: "eof", text: "", start: n, end: n, line });
  return tokens;
}
function significantTokens(tokens) {
  return tokens.filter(
    (t) => t.type !== "whitespace" && t.type !== "newline" && t.type !== "comment-line" && t.type !== "comment-block"
  );
}
function splitStatements(tokens) {
  const out = [];
  let cur = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.type === "eof") {
      if (cur.length) out.push(cur);
      break;
    }
    if (t.type === "punctuation" && t.text === "(") depth++;
    else if (t.type === "punctuation" && t.text === ")") depth = Math.max(0, depth - 1);
    if (t.type === "punctuation" && t.text === ";" && depth === 0) {
      if (cur.length) out.push(cur);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  if (cur.length) out.push(cur);
  return out;
}
var KEYWORDS = /* @__PURE__ */ new Set([
  // Reserved
  "ALL",
  "ANALYSE",
  "ANALYZE",
  "AND",
  "ANY",
  "ARRAY",
  "AS",
  "ASC",
  "ASYMMETRIC",
  "AUTHORIZATION",
  "BINARY",
  "BOTH",
  "CASE",
  "CAST",
  "CHECK",
  "COLLATE",
  "COLLATION",
  "COLUMN",
  "CONCURRENTLY",
  "CONSTRAINT",
  "CREATE",
  "CROSS",
  "CURRENT_CATALOG",
  "CURRENT_DATE",
  "CURRENT_ROLE",
  "CURRENT_SCHEMA",
  "CURRENT_TIME",
  "CURRENT_TIMESTAMP",
  "CURRENT_USER",
  "DEFAULT",
  "DEFERRABLE",
  "DESC",
  "DISTINCT",
  "DO",
  "ELSE",
  "END",
  "EXCEPT",
  "FALSE",
  "FETCH",
  "FOR",
  "FOREIGN",
  "FREEZE",
  "FROM",
  "FULL",
  "GRANT",
  "GROUP",
  "HAVING",
  "ILIKE",
  "IN",
  "INITIALLY",
  "INNER",
  "INTERSECT",
  "INTO",
  "IS",
  "ISNULL",
  "JOIN",
  "LATERAL",
  "LEADING",
  "LEFT",
  "LIKE",
  "LIMIT",
  "LOCALTIME",
  "LOCALTIMESTAMP",
  "NATURAL",
  "NOT",
  "NOTNULL",
  "NULL",
  "OFFSET",
  "ON",
  "ONLY",
  "OR",
  "ORDER",
  "OUTER",
  "OVERLAPS",
  "PLACING",
  "PRIMARY",
  "REFERENCES",
  "RETURNING",
  "RIGHT",
  "SELECT",
  "SESSION_USER",
  "SIMILAR",
  "SOME",
  "SYMMETRIC",
  "TABLE",
  "TABLESAMPLE",
  "THEN",
  "TO",
  "TRAILING",
  "TRUE",
  "UNION",
  "UNIQUE",
  "USER",
  "USING",
  "VARIADIC",
  "VERBOSE",
  "WHEN",
  "WHERE",
  "WINDOW",
  "WITH",
  // Non-reserved but commonly used
  "ABORT",
  "ABSOLUTE",
  "ACCESS",
  "ACTION",
  "ADD",
  "ADMIN",
  "AFTER",
  "AGGREGATE",
  "ALSO",
  "ALTER",
  "ALWAYS",
  "ASSERTION",
  "ASSIGNMENT",
  "AT",
  "ATTACH",
  "ATTRIBUTE",
  "BACKWARD",
  "BEFORE",
  "BEGIN",
  "BY",
  "CACHE",
  "CALL",
  "CALLED",
  "CASCADE",
  "CASCADED",
  "CATALOG",
  "CHAIN",
  "CHARACTERISTICS",
  "CHECKPOINT",
  "CLASS",
  "CLOSE",
  "CLUSTER",
  "COLUMNS",
  "COMMENT",
  "COMMENTS",
  "COMMIT",
  "COMMITTED",
  "COMPRESSION",
  "CONFIGURATION",
  "CONFLICT",
  "CONNECTION",
  "CONSTRAINTS",
  "CONTENT",
  "CONTINUE",
  "CONVERSION",
  "COPY",
  "COST",
  "CSV",
  "CUBE",
  "CURRENT",
  "CURSOR",
  "CYCLE",
  "DATA",
  "DATABASE",
  "DAY",
  "DAYS",
  "DEALLOCATE",
  "DECLARE",
  "DEFAULTS",
  "DEFERRED",
  "DEFINER",
  "DELETE",
  "DELIMITER",
  "DELIMITERS",
  "DEPENDS",
  "DETACH",
  "DICTIONARY",
  "DISABLE",
  "DISCARD",
  "DOCUMENT",
  "DOMAIN",
  "DOUBLE",
  "DROP",
  "EACH",
  "ENABLE",
  "ENCODING",
  "ENCRYPTED",
  "ENUM",
  "ESCAPE",
  "EVENT",
  "EXCLUDE",
  "EXCLUDING",
  "EXCLUSIVE",
  "EXECUTE",
  "EXISTS",
  "EXPLAIN",
  "EXPRESSION",
  "EXTENSION",
  "EXTERNAL",
  "FAMILY",
  "FILTER",
  "FIRST",
  "FOLLOWING",
  "FORCE",
  "FORWARD",
  "FUNCTION",
  "FUNCTIONS",
  "GLOBAL",
  "GRANTED",
  "HANDLER",
  "HEADER",
  "HOLD",
  "HOUR",
  "HOURS",
  "IDENTITY",
  "IF",
  "IMMEDIATE",
  "IMMUTABLE",
  "IMPLICIT",
  "IMPORT",
  "INCLUDE",
  "INCLUDING",
  "INCREMENT",
  "INDEX",
  "INDEXES",
  "INHERIT",
  "INHERITS",
  "INLINE",
  "INPUT",
  "INSENSITIVE",
  "INSERT",
  "INSTEAD",
  "INVOKER",
  "ISOLATION",
  "JSON",
  "JSONB",
  "KEY",
  "LABEL",
  "LANGUAGE",
  "LARGE",
  "LAST",
  "LEAKPROOF",
  "LEVEL",
  "LISTEN",
  "LOAD",
  "LOCAL",
  "LOCATION",
  "LOCK",
  "LOCKED",
  "LOGGED",
  "MAPPING",
  "MATCH",
  "MATCHED",
  "MATERIALIZED",
  "MAXVALUE",
  "METHOD",
  "MINUTE",
  "MINUTES",
  "MINVALUE",
  "MODE",
  "MONTH",
  "MONTHS",
  "MOVE",
  "NAME",
  "NAMES",
  "NEW",
  "NEXT",
  "NO",
  "NOTHING",
  "NOTIFY",
  "NOWAIT",
  "NULLS",
  "OBJECT",
  "OF",
  "OFF",
  "OIDS",
  "OLD",
  "OPERATOR",
  "OPTION",
  "OPTIONS",
  "OVER",
  "OVERRIDING",
  "OWNED",
  "OWNER",
  "PARALLEL",
  "PARSER",
  "PARTIAL",
  "PARTITION",
  "PASSING",
  "PASSWORD",
  "PERSISTENT",
  "PLANS",
  "POLICY",
  "PRECEDING",
  "PRECISION",
  "PREPARE",
  "PREPARED",
  "PRESERVE",
  "PRIOR",
  "PRIVILEGES",
  "PROCEDURAL",
  "PROCEDURE",
  "PROCEDURES",
  "PROGRAM",
  "PUBLICATION",
  "QUOTE",
  "RANGE",
  "READ",
  "REAL",
  "REASSIGN",
  "RECHECK",
  "RECURSIVE",
  "REF",
  "REFERENCING",
  "REFRESH",
  "REINDEX",
  "RELATIVE",
  "RELEASE",
  "RENAME",
  "REPEATABLE",
  "REPLACE",
  "REPLICA",
  "RESET",
  "RESTART",
  "RESTRICT",
  "RETURN",
  "REVOKE",
  "ROLE",
  "ROLLBACK",
  "ROLLUP",
  "ROUTINE",
  "ROUTINES",
  "ROW",
  "ROWS",
  "RULE",
  "SAVEPOINT",
  "SCHEMA",
  "SCHEMAS",
  "SCROLL",
  "SEARCH",
  "SECOND",
  "SECONDS",
  "SECRET",
  "SECURITY",
  "SEQUENCE",
  "SEQUENCES",
  "SERIALIZABLE",
  "SERVER",
  "SESSION",
  "SET",
  "SETS",
  "SHARE",
  "SHOW",
  "SIMPLE",
  "SKIP",
  "SNAPSHOT",
  "SQL",
  "STABLE",
  "STANDALONE",
  "START",
  "STATEMENT",
  "STATISTICS",
  "STDIN",
  "STDOUT",
  "STORAGE",
  "STORED",
  "STRICT",
  "STRIP",
  "SUBSCRIPTION",
  "SYSID",
  "SYSTEM",
  "TABLES",
  "TABLESPACE",
  "TEMP",
  "TEMPLATE",
  "TEMPORARY",
  "TEXT",
  "TRANSACTION",
  "TRANSFORM",
  "TRIGGER",
  "TRUNCATE",
  "TRUSTED",
  "TYPE",
  "TYPES",
  "UNBOUNDED",
  "UNCOMMITTED",
  "UNENCRYPTED",
  "UNKNOWN",
  "UNLISTEN",
  "UNLOGGED",
  "UNTIL",
  "UPDATE",
  "VACUUM",
  "VALID",
  "VALIDATE",
  "VALIDATOR",
  "VALUE",
  "VARIABLE",
  "VARYING",
  "VERSION",
  "VIEW",
  "VIEWS",
  "VIRTUAL",
  "VOLATILE",
  "WHITESPACE",
  "WITHIN",
  "WITHOUT",
  "WORK",
  "WRAPPER",
  "WRITE",
  "XML",
  "YEAR",
  "YEARS",
  "YES",
  "ZONE"
]);

// src/lib/sql-reference.ts
function normalizeType(type) {
  const trimmed = type.trim().toLowerCase();
  const arrMatch = trimmed.match(/^(.+?)\s*(?:\[\s*\])+$/);
  let core = trimmed;
  let isArray = false;
  if (arrMatch) {
    core = arrMatch[1].trim();
    isArray = true;
  }
  core = core.replace(/\s*\([^)]*\)\s*$/, "").trim();
  core = core.replace(/\s+with(out)?\s+time\s+zone$/, "").trim();
  const alias = {
    int: "integer",
    int4: "integer",
    int8: "bigint",
    int2: "smallint",
    serial: "integer",
    bigserial: "bigint",
    smallserial: "smallint",
    bool: "boolean",
    decimal: "numeric",
    float: "double precision",
    float8: "double precision",
    float4: "real",
    "character varying": "varchar",
    char: "bpchar",
    character: "bpchar",
    timestamp: "timestamptz",
    json: "jsonb"
  };
  return { baseType: alias[core] ?? core, isArray, original: type };
}

// src/types/schema-graph.ts
function foldKey(name, quoted) {
  return quoted ? name : name.toLowerCase();
}
function relationKey(schema, name, schemaQuoted = false, nameQuoted = false) {
  return `${foldKey(schema, schemaQuoted)}.${foldKey(name, nameQuoted)}`;
}

// src/lib/jsonb-parser.ts
var ANNOT_PREFIX = "@pg4-jsonb";
function extractJsonbAnnotations(rawDdl) {
  const annotations = [];
  const warnings = [];
  const lines = rawDdl.split("\n");
  lines.forEach((lineText, idx) => {
    const line = lineText.trim();
    if (!line.startsWith("--")) return;
    const afterDashes = line.slice(2).trim();
    if (!afterDashes.startsWith(ANNOT_PREFIX)) return;
    const rest = afterDashes.slice(ANNOT_PREFIX.length).trim();
    const parsed = parseOneAnnotation(rest, idx + 1, lineText);
    if ("error" in parsed) {
      warnings.push({
        line: idx + 1,
        excerpt: truncate(lineText, 120),
        code: "jsonb-annotation",
        message: parsed.error
      });
      return;
    }
    annotations.push(parsed);
  });
  return { annotations, warnings };
}
function parseOneAnnotation(rest, lineNo, raw) {
  let comment;
  let core = rest;
  const quotedComment = core.match(/"([^"]*)"\s*$/);
  if (quotedComment) {
    comment = quotedComment[1];
    core = core.slice(0, quotedComment.index).trim();
  }
  const firstSpace = core.search(/\s/);
  if (firstSpace < 0) {
    return { error: "missing path specification" };
  }
  const target = core.slice(0, firstSpace).trim();
  const pathType = core.slice(firstSpace + 1).trim();
  const targetParts = target.split(".");
  if (targetParts.length !== 3 || targetParts.some((p) => !p)) {
    return { error: `invalid target "${target}", expected schema.table.column` };
  }
  const [schema, table, column] = targetParts;
  const colonIdx = pathType.lastIndexOf(":");
  let pathStr;
  let valueType;
  if (colonIdx < 0) {
    pathStr = pathType;
  } else {
    pathStr = pathType.slice(0, colonIdx).trim();
    valueType = pathType.slice(colonIdx + 1).trim() || void 0;
  }
  if (!pathStr) {
    return { error: "empty path" };
  }
  const segments = parsePathSegments(pathStr, lineNo, raw);
  if (segments.length === 0) {
    return { error: "could not parse path segments" };
  }
  return { schema, table, column, segments, valueType, comment };
}
function parsePathSegments(pathStr, lineNo, raw) {
  const segments = [];
  if (pathStr.startsWith("/")) {
    const parts2 = pathStr.split("/").slice(1);
    for (const p of parts2) {
      const seg = p.replace(/~1/g, "/").replace(/~0/g, "~");
      if (seg === "" || seg === "-") continue;
      segments.push(seg);
    }
    return segments;
  }
  const parts = pathStr.split(".");
  for (const p of parts) {
    if (!p) continue;
    segments.push(p);
  }
  return segments;
}
function buildJsonbTree(annotations) {
  const warnings = [];
  const roots = [];
  for (const ann of annotations) {
    let level = roots;
    for (let i = 0; i < ann.segments.length; i++) {
      const segRaw = ann.segments[i];
      const isArray = segRaw.endsWith("[]");
      const name = isArray ? segRaw.slice(0, -2) : segRaw;
      if (!name) {
        warnings.push({
          line: 0,
          excerpt: ann.segments.join("."),
          code: "jsonb-path",
          message: `empty segment in path "${ann.segments.join(".")}"`
        });
        break;
      }
      const isLeaf = i === ann.segments.length - 1;
      let node = level.find((n) => n.displayPath === name || lastSegment(n) === name);
      if (!node) {
        node = {
          segments: [],
          displayPath: name,
          isArray,
          valueType: isLeaf ? ann.valueType ?? "unknown" : void 0,
          nullable: void 0,
          comment: isLeaf ? ann.comment : void 0,
          children: []
        };
        level.push(node);
      } else if (isLeaf) {
        node.valueType = ann.valueType ?? node.valueType ?? "unknown";
        if (ann.comment) node.comment = ann.comment;
        if (isArray) node.isArray = true;
      } else {
        if (isArray) node.isArray = true;
      }
      level = node.children;
    }
  }
  const finalize = (nodes, prefix) => {
    for (const n of nodes) {
      n.segments = [...prefix, n.displayPath + (n.isArray ? "[]" : "")];
      n.displayPath = n.segments.map((s) => s.replace(/\[\]$/, "")).join(".");
      finalize(n.children, n.segments);
    }
  };
  finalize(roots, []);
  return { roots, warnings };
}
function lastSegment(node) {
  return node.displayPath.split(".").pop() ?? node.displayPath;
}
function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n) + "\u2026";
}

// src/lib/ddl-parser.ts
var DDL_PARSER_VERSION = 1;
function parseDdl(rawDdl, snapshotId, displayName, sourceFileName) {
  const graph = {
    snapshotId,
    displayName,
    sourceFileName,
    importedAt: (/* @__PURE__ */ new Date()).toISOString(),
    parserVersion: DDL_PARSER_VERSION,
    schemas: {},
    functions: []
  };
  const ctx = { graph, warnings: [] };
  const { annotations, warnings: annotWarnings } = extractJsonbAnnotations(rawDdl);
  ctx.warnings.push(...annotWarnings);
  const annotationsByColumn = /* @__PURE__ */ new Map();
  for (const a of annotations) {
    const k = `${a.schema.toLowerCase()}.${a.table.toLowerCase()}.${a.column.toLowerCase()}`;
    const arr = annotationsByColumn.get(k) ?? [];
    arr.push(a);
    annotationsByColumn.set(k, arr);
  }
  const tokens = tokenize(rawDdl);
  const sig = significantTokens(tokens);
  const statements = splitStatements(sig);
  for (const stmt of statements) {
    if (stmt.length === 0) continue;
    try {
      parseStatement(stmt, ctx);
    } catch (e) {
      ctx.warnings.push({
        line: stmt[0]?.line ?? 0,
        excerpt: tokensFor(stmt).slice(0, 120),
        code: "statement-error",
        message: e?.message ?? String(e)
      });
    }
  }
  for (const [colKey, anns] of annotationsByColumn) {
    const [schema, table, column] = colKey.split(".");
    const rel = lookupRelation(ctx.graph, schema, table);
    if (!rel) {
      ctx.warnings.push({
        line: 0,
        excerpt: `${schema}.${table}.${column}`,
        code: "jsonb-target-missing",
        message: `@pg4-jsonb targets unknown column ${schema}.${table}.${column}`
      });
      continue;
    }
    const col = rel.columns.find((c) => c.key === column);
    if (!col) {
      ctx.warnings.push({
        line: 0,
        excerpt: `${schema}.${table}.${column}`,
        code: "jsonb-target-missing",
        message: `@pg4-jsonb targets unknown column ${schema}.${table}.${column}`
      });
      continue;
    }
    if (col.baseType !== "jsonb" && col.baseType !== "json") {
      ctx.warnings.push({
        line: 0,
        excerpt: `${schema}.${table}.${column}`,
        code: "jsonb-target-type",
        message: `@pg4-jsonb on non-JSON column ${col.dataType} ${schema}.${table}.${column}`
      });
    }
    const { roots, warnings: treeWarnings } = buildJsonbTree(anns);
    col.jsonbPaths = roots;
    ctx.warnings.push(...treeWarnings);
  }
  return { graph, warnings: ctx.warnings };
}
function tokensFor(stmt) {
  return stmt.map((t) => t.text).join("");
}
function parseStatement(stmt, ctx) {
  const kw = upperAt(stmt, 0);
  if (kw === "CREATE") parseCreate(stmt, ctx);
  else if (kw === "ALTER") parseAlter(stmt, ctx);
  else if (kw === "COMMENT") parseComment(stmt, ctx);
  else if (kw === "SET" || kw === "SELECT" || kw === "INSERT" || kw === "UPDATE" || kw === "DELETE") {
  } else if (kw === "GRANT" || kw === "REVOKE") {
  } else {
    ctx.warnings.push({
      line: stmt[0]?.line ?? 0,
      excerpt: tokensFor(stmt).slice(0, 120),
      code: "unsupported-statement",
      message: `unsupported statement starting with "${kw}"`
    });
  }
}
function parseCreate(stmt, ctx) {
  let i = 1;
  i = skipOrReplace(stmt, i);
  if (upperAt(stmt, i) === "UNLOGGED" || upperAt(stmt, i) === "TEMP" || upperAt(stmt, i) === "TEMPORARY") i++;
  const obj = upperAt(stmt, i);
  switch (obj) {
    case "SCHEMA":
      parseCreateSchema(stmt, i + 1, ctx);
      break;
    case "TABLE":
      parseCreateTable(stmt, i + 1, ctx);
      break;
    case "VIEW":
      parseCreateRelation(stmt, i + 1, "view", ctx);
      break;
    case "MATERIALIZED":
      if (upperAt(stmt, i + 1) === "VIEW") parseCreateRelation(stmt, i + 2, "materialized-view", ctx);
      else unsupported(stmt, ctx, obj);
      break;
    case "FOREIGN":
      if (upperAt(stmt, i + 1) === "TABLE") parseCreateRelation(stmt, i + 2, "foreign-table", ctx);
      else unsupported(stmt, ctx, obj);
      break;
    case "UNIQUE":
    case "INDEX":
      parseCreateIndex(stmt, i, ctx);
      break;
    case "FUNCTION":
    case "PROCEDURE":
      parseCreateFunction(stmt, i + 1, ctx);
      break;
    default:
      unsupported(stmt, ctx, obj);
  }
}
function skipOrReplace(stmt, i) {
  if (upperAt(stmt, i) === "OR" && upperAt(stmt, i + 1) === "REPLACE") return i + 2;
  return i;
}
function parseCreateSchema(stmt, start, ctx) {
  let i = start;
  if (upperAt(stmt, i) === "IF" && upperAt(stmt, i + 1) === "NOT" && upperAt(stmt, i + 2) === "EXISTS") i += 3;
  const nameTok = stmt[i];
  if (!nameTok || nameTok.type !== "identifier" && nameTok.type !== "quoted-identifier") {
    ctx.warnings.push(warn(stmt, "schema-name", "expected schema name"));
    return;
  }
  const quoted = nameTok.type === "quoted-identifier";
  const name = nameTok.value ?? nameTok.text;
  ensureSchema(ctx.graph, name, quoted);
}
function parseCreateTable(stmt, start, ctx) {
  let i = start;
  if (upperAt(stmt, i) === "IF" && upperAt(stmt, i + 1) === "NOT" && upperAt(stmt, i + 2) === "EXISTS") i += 3;
  const { schemaName, relName, schemaQuoted, relQuoted, end } = readQualifiedName(stmt, i, ctx);
  if (!relName) return;
  i = end;
  const paren = stmt[i];
  if (!paren || paren.type !== "punctuation" || paren.text !== "(") {
    ctx.warnings.push(warn(stmt, "table-no-body", `CREATE TABLE ${relName} without column list`));
    return;
  }
  const closeIdx = findMatchingParen(stmt, i);
  if (closeIdx < 0) {
    ctx.warnings.push(warn(stmt, "unbalanced-parens", "unbalanced parentheses in CREATE TABLE"));
    return;
  }
  const innerTokens = stmt.slice(i + 1, closeIdx);
  const schema = ensureSchema(ctx.graph, schemaName, schemaQuoted);
  const table = {
    kind: "table",
    schema: schema.name,
    name: relName,
    key: relationKey(schema.name, relName, schema.quoted, relQuoted),
    quoted: relQuoted,
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    indexes: []
  };
  schema.relations[table.key] = table;
  parseTableBody(innerTokens, table, ctx);
  for (const col of table.columns) {
    if (table.primaryKey.some((pk) => pk.toLowerCase() === col.key.toLowerCase())) col.isPrimaryKey = true;
  }
}
function parseCreateRelation(stmt, start, kind, ctx) {
  let i = start;
  if (upperAt(stmt, i) === "IF" && upperAt(stmt, i + 1) === "NOT" && upperAt(stmt, i + 2) === "EXISTS") i += 3;
  const { schemaName, relName, schemaQuoted, relQuoted, end } = readQualifiedName(stmt, i, ctx);
  if (!relName) return;
  const schema = ensureSchema(ctx.graph, schemaName, schemaQuoted);
  const rel = {
    kind,
    schema: schema.name,
    name: relName,
    key: relationKey(schema.name, relName, schema.quoted, relQuoted),
    quoted: relQuoted,
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    indexes: []
  };
  schema.relations[rel.key] = rel;
  if (kind === "foreign-table") {
    const paren = stmt[end];
    if (paren && paren.type === "punctuation" && paren.text === "(") {
      const closeIdx = findMatchingParen(stmt, end);
      if (closeIdx > 0) parseTableBody(stmt.slice(end + 1, closeIdx), rel, ctx);
    }
  }
}
function parseTableBody(inner, table, ctx) {
  const items = splitTopLevelCommas(inner);
  for (const item of items) {
    if (item.length === 0) continue;
    const leadingKw = upperAt(item, 0);
    if (leadingKw === "CONSTRAINT") {
      parseTableConstraint(item, 1, table, ctx);
    } else if (leadingKw === "PRIMARY" && upperAt(item, 1) === "KEY") {
      parsePrimaryKeyConstraint(item, 2, table, ctx);
    } else if (leadingKw === "UNIQUE") {
      parseUniqueConstraint(item, 1, table, ctx);
    } else if (leadingKw === "FOREIGN" && upperAt(item, 1) === "KEY") {
      parseForeignKeyConstraint(item, 2, table, ctx);
    } else if (leadingKw === "CHECK") {
    } else if (leadingKw === "EXCLUDE") {
    } else {
      parseColumnDef(item, table, ctx);
    }
  }
}
function parseColumnDef(item, table, ctx) {
  const nameTok = item[0];
  if (!nameTok || nameTok.type !== "identifier" && nameTok.type !== "quoted-identifier") {
    ctx.warnings.push(warn(item, "column-name", "expected column name"));
    return;
  }
  const quoted = nameTok.type === "quoted-identifier";
  const name = nameTok.value ?? nameTok.text;
  const typeEnd = findColumnOptionStart(item, 1);
  const typeTokens = item.slice(1, typeEnd);
  if (typeTokens.length === 0) {
    ctx.warnings.push(warn(item, "column-type", `column ${name} has no type`));
    return;
  }
  const dataType = typeTokens.map((t) => t.text).join("").trim();
  const { baseType, isArray } = normalizeType(dataType);
  const col = {
    name,
    key: foldKey(name, quoted),
    quoted,
    dataType,
    baseType: isArray ? `${baseType}[]` : baseType,
    nullable: true,
    ordinal: table.columns.length + 1,
    isPrimaryKey: false
  };
  for (let i = typeEnd; i < item.length; i++) {
    const kw = upperAt(item, i);
    switch (kw) {
      case "NOT":
        if (upperAt(item, i + 1) === "NULL") {
          col.nullable = false;
          i++;
        }
        break;
      case "NULL":
        col.nullable = true;
        break;
      case "DEFAULT":
        col.defaultExpression = tokensFor(item.slice(i + 1)).trim() || void 0;
        i = item.length;
        break;
      case "PRIMARY":
        if (upperAt(item, i + 1) === "KEY") {
          col.isPrimaryKey = true;
          if (!table.primaryKey.includes(name)) table.primaryKey.push(name);
          i++;
        }
        break;
      case "UNIQUE":
        break;
      case "REFERENCES":
      case "FOREIGN": {
        const refStart = kw === "FOREIGN" ? i + 1 : i;
        const fk = parseReferences(item, refStart + 1, table, ctx);
        if (fk) {
          col.foreignKey = fk;
          i = fk._endIndex ?? i;
          delete fk._endIndex;
        }
        break;
      }
      case "GENERATED":
        break;
      case "CHECK":
        i = item.length;
        break;
      case "COLLATE":
        i++;
        break;
    }
  }
  table.columns.push(col);
}
function parseReferences(item, start, table, ctx) {
  const { schemaName, relName, end } = readQualifiedName(item, start, ctx);
  if (!relName) return null;
  let i = end;
  let cols = [];
  const openTok = item[i];
  if (openTok && openTok.type === "punctuation" && openTok.text === "(") {
    const closeIdx = findMatchingParen(item, i);
    if (closeIdx > 0) {
      cols = splitTopLevelCommas(item.slice(i + 1, closeIdx)).map((p) => p.map((t) => t.text).join("")).map((s) => s.trim()).filter(Boolean);
      i = closeIdx + 1;
    }
  }
  while (i < item.length) {
    const kw = upperAt(item, i);
    if (kw === "ON" || kw === "MATCH" || kw === "DEFERRABLE" || kw === "INITIALLY" || kw === "NOT") {
      i++;
    } else {
      break;
    }
  }
  const fk = {
    name: void 0,
    localColumns: [],
    referencedSchema: schemaName,
    referencedTable: relName,
    referencedColumns: cols,
    _endIndex: i - 1
  };
  return fk;
}
function parseTableConstraint(stmt, start, table, ctx) {
  const nameTok = stmt[start];
  let i = start + 1;
  const constraintName = nameTok && (nameTok.type === "identifier" || nameTok.type === "quoted-identifier") ? nameTok.value ?? nameTok.text : void 0;
  const kw = upperAt(stmt, i);
  if (kw === "PRIMARY" && upperAt(stmt, i + 1) === "KEY") {
    parsePrimaryKeyConstraint(stmt, i + 2, table, ctx, constraintName);
  } else if (kw === "UNIQUE") {
    parseUniqueConstraint(stmt, i + 1, table, ctx, constraintName);
  } else if (kw === "FOREIGN" && upperAt(stmt, i + 1) === "KEY") {
    parseForeignKeyConstraint(stmt, i + 2, table, ctx, constraintName);
  } else if (kw === "CHECK" || kw === "EXCLUDE") {
  }
}
function parsePrimaryKeyConstraint(stmt, start, table, ctx, name) {
  const cols = readParenColumns(stmt, start);
  if (cols.length === 0) return;
  table.primaryKey = Array.from(/* @__PURE__ */ new Set([...table.primaryKey, ...cols]));
}
function parseUniqueConstraint(stmt, start, table, ctx, name) {
  const cols = readParenColumns(stmt, start);
  if (cols.length === 0) return;
  table.indexes.push({
    name: name ?? `__unique_${table.indexes.length}`,
    columns: cols,
    unique: true
  });
}
function parseForeignKeyConstraint(stmt, start, table, ctx, name) {
  const localCols = readParenColumns(stmt, start);
  let i = skipParen(stmt, start);
  if (upperAt(stmt, i) !== "REFERENCES") return;
  i++;
  const { schemaName, relName, end } = readQualifiedName(stmt, i, ctx);
  if (!relName) return;
  const refCols = readParenColumns(stmt, end);
  table.foreignKeys.push({
    name,
    localColumns: localCols,
    referencedSchema: schemaName,
    referencedTable: relName,
    referencedColumns: refCols
  });
  for (const lc of localCols) {
    const col = table.columns.find((c) => c.key === lc.toLowerCase());
    if (col && !col.foreignKey) {
      col.foreignKey = {
        name,
        localColumns: localCols,
        referencedSchema: schemaName,
        referencedTable: relName,
        referencedColumns: refCols
      };
    }
  }
}
function readParenColumns(stmt, start) {
  const paren = stmt[start];
  if (!paren || paren.type !== "punctuation" || paren.text !== "(") return [];
  const closeIdx = findMatchingParen(stmt, start);
  if (closeIdx < 0) return [];
  const inner = stmt.slice(start + 1, closeIdx);
  return splitTopLevelCommas(inner).map((p) => p.map((t) => t.text).join("").trim()).map((s) => s.replace(/["']/g, "")).filter(Boolean);
}
function skipParen(stmt, start) {
  if (stmt[start]?.text === "(") {
    const closeIdx = findMatchingParen(stmt, start);
    return closeIdx < 0 ? start + 1 : closeIdx + 1;
  }
  return start;
}
function findColumnOptionStart(item, from) {
  const stopKws = /* @__PURE__ */ new Set([
    "NOT",
    "NULL",
    "DEFAULT",
    "PRIMARY",
    "UNIQUE",
    "REFERENCES",
    "FOREIGN",
    "CHECK",
    "GENERATED",
    "COLLATE",
    "CONSTRAINT"
  ]);
  let depth = 0;
  for (let i = from; i < item.length; i++) {
    const t = item[i];
    if (t.type === "punctuation" && t.text === "(") depth++;
    else if (t.type === "punctuation" && t.text === ")") depth--;
    if (depth === 0 && t.type === "keyword" && stopKws.has(t.text.toUpperCase())) {
      return i;
    }
  }
  return item.length;
}
function parseCreateIndex(stmt, start, ctx) {
  let i = start;
  let unique = false;
  if (upperAt(stmt, i) === "UNIQUE") {
    unique = true;
    i++;
  }
  if (upperAt(stmt, i) !== "INDEX") return;
  i++;
  if (upperAt(stmt, i) === "CONCURRENTLY") i++;
  if (upperAt(stmt, i) === "IF" && upperAt(stmt, i + 1) === "NOT" && upperAt(stmt, i + 2) === "EXISTS") i += 3;
  const nameTok = stmt[i];
  if (nameTok && (nameTok.type === "identifier" || nameTok.type === "quoted-identifier")) {
    i++;
  }
  if (upperAt(stmt, i) === "ON") i++;
  const { schemaName, relName, end } = readQualifiedName(stmt, i, ctx);
  if (!relName) return;
  const rel = lookupRelation(ctx.graph, schemaName, relName);
  if (!rel) {
    ctx.warnings.push(warn(stmt, "index-target-missing", `CREATE INDEX on unknown table ${schemaName}.${relName}`));
    return;
  }
  const cols = readParenColumns(stmt, end);
  const isPartial = stmt.slice(end).some((t) => t.type === "keyword" && t.text.toUpperCase() === "WHERE");
  let name = `__index_${rel.indexes.length}`;
  for (let k = end - 1; k >= 0; k--) {
    const tk = stmt[k];
    if (tk && (tk.type === "identifier" || tk.type === "quoted-identifier")) {
      name = tk.value ?? tk.text;
      break;
    }
  }
  rel.indexes.push({ name, columns: cols, unique, partial: isPartial });
}
function parseCreateFunction(stmt, start, ctx) {
  let i = start;
  i = skipOrReplace(stmt, i);
  const { schemaName, relName: fnName, schemaQuoted, relQuoted: fnQuoted, end } = readQualifiedName(stmt, i, ctx);
  if (!fnName) return;
  i = end;
  const argsOpenTok = stmt[i];
  if (!argsOpenTok || argsOpenTok.text !== "(") return;
  const closeIdx = findMatchingParen(stmt, i);
  if (closeIdx < 0) return;
  const argsTokens = stmt.slice(i + 1, closeIdx);
  const args = parseFunctionArgs(argsTokens);
  i = closeIdx + 1;
  let returnType = "void";
  if (upperAt(stmt, i) === "RETURNS") {
    i++;
    if (upperAt(stmt, i) === "SETOF") i++;
    const typeTokens = [];
    while (i < stmt.length) {
      const kw = upperAt(stmt, i);
      if (kw === "LANGUAGE" || kw === "AS" || kw === "WINDOW" || kw === "STRICT" || kw === "VOLATILE" || kw === "STABLE" || kw === "IMMUTABLE" || kw === "SECURITY" || kw === "PARALLEL" || kw === "COST" || kw === "ROWS") break;
      typeTokens.push(stmt[i]);
      i++;
    }
    returnType = typeTokens.map((t) => t.text).join("").trim() || returnType;
  }
  let language;
  while (i < stmt.length) {
    if (upperAt(stmt, i) === "LANGUAGE") {
      language = stmt[i + 1]?.text;
      i += 2;
    } else i++;
  }
  const fn = {
    schema: schemaName,
    name: fnName,
    key: `${schemaName.toLowerCase()}.${fnName.toLowerCase()}`,
    args,
    returnType,
    language,
    quoted: fnQuoted
  };
  ctx.graph.functions.push(fn);
}
function parseFunctionArgs(tokens) {
  const args = [];
  if (tokens.length === 0) return args;
  const parts = splitTopLevelCommas(tokens);
  for (const part of parts) {
    if (part.length === 0) continue;
    let mode = "in";
    let j = 0;
    const first = upperAt(part, 0);
    if (first === "IN") {
      mode = "in";
      j = 1;
    } else if (first === "OUT") {
      mode = "out";
      j = 1;
    } else if (first === "INOUT") {
      mode = "inout";
      j = 1;
    } else if (first === "VARIADIC") {
      mode = "variadic";
      j = 1;
    }
    let name;
    let dataType;
    const nameTok = part[j];
    const typeTok = part[j + 1];
    if (nameTok && typeTok && (nameTok.type === "identifier" || nameTok.type === "quoted-identifier") && typeTok.type !== "punctuation") {
      name = nameTok.value ?? nameTok.text;
      dataType = part.slice(j + 1).map((t) => t.text).join("").trim();
    } else {
      dataType = part.slice(j).map((t) => t.text).join("").trim();
    }
    let defaultVal;
    const defIdx = part.findIndex((t) => t.type === "keyword" && t.text.toUpperCase() === "DEFAULT");
    if (defIdx >= 0) {
      defaultVal = part.slice(defIdx + 1).map((t) => t.text).join("").trim() || void 0;
      dataType = part.slice(j, defIdx).filter((t) => !(t.type === "keyword" && t.text.toUpperCase() === "DEFAULT")).map((t) => t.text).join("").trim();
    }
    if (!dataType) continue;
    args.push({ name, dataType, mode, default: defaultVal });
  }
  return args;
}
function parseAlter(stmt, ctx) {
  const obj = upperAt(stmt, 1);
  if (obj === "TABLE") {
    let i = 2;
    if (upperAt(stmt, i) === "IF" && upperAt(stmt, i + 1) === "EXISTS") i += 2;
    const { schemaName, relName, end } = readQualifiedName(stmt, i, ctx);
    if (!relName) return;
    const rel = lookupRelation(ctx.graph, schemaName, relName);
    i = end;
    const action = upperAt(stmt, i);
    if (action === "ADD") {
      let j = i + 1;
      if (upperAt(stmt, j) === "CONSTRAINT") {
        const nameTok = stmt[j + 1];
        const constraintName = nameTok && (nameTok.type === "identifier" || nameTok.type === "quoted-identifier") ? nameTok.value ?? nameTok.text : void 0;
        const typeKw = upperAt(stmt, j + 2);
        if (typeKw === "PRIMARY" && upperAt(stmt, j + 3) === "KEY") {
          if (rel) parsePrimaryKeyConstraint(stmt, j + 4, rel, ctx, constraintName);
        } else if (typeKw === "UNIQUE") {
          if (rel) parseUniqueConstraint(stmt, j + 3, rel, ctx, constraintName);
        } else if (typeKw === "FOREIGN" && upperAt(stmt, j + 3) === "KEY") {
          if (rel) parseForeignKeyConstraint(stmt, j + 4, rel, ctx, constraintName);
        }
      } else {
        const typeKw = upperAt(stmt, j);
        if (typeKw === "PRIMARY" && upperAt(stmt, j + 1) === "KEY") {
          if (rel) parsePrimaryKeyConstraint(stmt, j + 2, rel, ctx);
        } else if (typeKw === "UNIQUE") {
          if (rel) parseUniqueConstraint(stmt, j + 1, rel, ctx);
        } else if (typeKw === "FOREIGN" && upperAt(stmt, j + 1) === "KEY") {
          if (rel) parseForeignKeyConstraint(stmt, j + 2, rel, ctx);
        }
      }
    } else if (action === "ALTER" && upperAt(stmt, i + 1) === "COLUMN") {
      const colTok = stmt[i + 2];
      if (!colTok || !rel) return;
      const colName = (colTok.value ?? colTok.text).toLowerCase();
      const col = rel.columns.find((c) => c.key === colName);
      if (!col) return;
      const op = upperAt(stmt, i + 3);
      if (op === "SET" && upperAt(stmt, i + 4) === "DEFAULT") {
        col.defaultExpression = stmt.slice(i + 5).map((t) => t.text).join("").trim() || void 0;
      } else if (op === "DROP" && upperAt(stmt, i + 4) === "DEFAULT") {
        col.defaultExpression = void 0;
      } else if (op === "SET" && upperAt(stmt, i + 4) === "NOT" && upperAt(stmt, i + 5) === "NULL") {
        col.nullable = false;
      } else if (op === "DROP" && upperAt(stmt, i + 4) === "NOT" && upperAt(stmt, i + 5) === "NULL") {
        col.nullable = true;
      } else if (op === "TYPE" || op === "SET" && upperAt(stmt, i + 4) === "DATA" && upperAt(stmt, i + 5) === "TYPE") {
        const typeStart = op === "TYPE" ? i + 4 : i + 6;
        const newType = stmt.slice(typeStart).map((t) => t.text).join("").trim().replace(/USING.*$/i, "").trim();
        if (newType) {
          const { baseType, isArray } = normalizeType(newType);
          col.dataType = newType;
          col.baseType = isArray ? `${baseType}[]` : baseType;
        }
      }
    }
  }
}
function parseComment(stmt, ctx) {
  const obj = upperAt(stmt, 2);
  let i = 3;
  if (obj === "TABLE") {
    const { schemaName, relName, end } = readQualifiedName(stmt, i, ctx);
    if (!relName) return;
    const rel = lookupRelation(ctx.graph, schemaName, relName);
    if (rel) {
      const comment = readStringLiteral(stmt, end);
      if (comment != null) rel.comment = comment;
    }
  } else if (obj === "COLUMN") {
    const { schemaName, relName, end } = readQualifiedName(stmt, i, ctx);
    if (!relName) return;
    let j = end;
    let colName;
    const dotTok = stmt[j];
    const colTok = stmt[j + 1];
    if (dotTok && dotTok.text === "." && colTok) {
      colName = (colTok.value ?? colTok.text).toLowerCase();
      j += 2;
    }
    if (!colName) return;
    const rel = lookupRelation(ctx.graph, schemaName, relName);
    if (rel) {
      const col = rel.columns.find((c) => c.key === colName);
      if (col) {
        const comment = readStringLiteral(stmt, j);
        if (comment != null) col.comment = comment;
      }
    }
  }
}
function readStringLiteral(stmt, from) {
  for (let i = from; i < stmt.length; i++) {
    if (stmt[i].type === "string") return (stmt[i].value ?? "") || "";
  }
  return null;
}
function readQualifiedName(stmt, from, ctx) {
  let schemaName = "public";
  let schemaQuoted = false;
  let relName = "";
  let relQuoted = false;
  let i = from;
  const first = stmt[i];
  if (!first || first.type !== "identifier" && first.type !== "quoted-identifier") {
    return { schemaName, relName, schemaQuoted, relQuoted, end: from };
  }
  const firstName = first.value ?? first.text;
  const firstQuoted = first.type === "quoted-identifier";
  const dotTok = stmt[i + 1];
  const relTok = stmt[i + 2];
  if (dotTok && dotTok.text === "." && relTok && (relTok.type === "identifier" || relTok.type === "quoted-identifier")) {
    schemaName = firstName;
    schemaQuoted = firstQuoted;
    relName = relTok.value ?? relTok.text;
    relQuoted = relTok.type === "quoted-identifier";
    i += 3;
  } else {
    relName = firstName;
    relQuoted = firstQuoted;
    i += 1;
  }
  return { schemaName, relName, schemaQuoted, relQuoted, end: i };
}
function ensureSchema(graph, name, quoted) {
  const key = foldKey(name, quoted);
  let s = graph.schemas[key];
  if (!s) {
    s = { name, key, quoted, relations: {} };
    graph.schemas[key] = s;
  }
  return s;
}
function lookupRelation(graph, schemaName, relName) {
  const sk = schemaName.toLowerCase();
  const rk = `${sk}.${relName.toLowerCase()}`;
  return graph.schemas[sk]?.relations[rk] ?? null;
}
function splitTopLevelCommas(tokens) {
  const out = [];
  let cur = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.type === "punctuation" && t.text === "(") depth++;
    else if (t.type === "punctuation" && t.text === ")") depth = Math.max(0, depth - 1);
    if (t.type === "punctuation" && t.text === "," && depth === 0) {
      out.push(cur);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  if (cur.length) out.push(cur);
  return out;
}
function findMatchingParen(tokens, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "punctuation" && t.text === "(") depth++;
    else if (t.type === "punctuation" && t.text === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function upperAt(stmt, i) {
  if (i < 0 || i >= stmt.length) return "";
  return stmt[i].text.toUpperCase();
}
function warn(stmt, code, message) {
  return {
    line: stmt[0]?.line ?? 0,
    excerpt: tokensFor(stmt).slice(0, 120),
    code,
    message
  };
}
function unsupported(stmt, ctx, obj) {
  ctx.warnings.push(warn(stmt, "unsupported-create", `unsupported CREATE ${obj}`));
}

// src/lib/schema-index.ts
function buildIndex(graph) {
  const index = { relations: {}, columns: {} };
  for (const schema of Object.values(graph.schemas)) {
    for (const rel of Object.values(schema.relations)) {
      const bareKey = rel.name.toLowerCase();
      const qualifiedKey = rel.key;
      (index.relations[bareKey] ??= []).push(qualifiedKey);
      const qualifiedKey2 = qualifiedKey;
      const cols = rel.columns.map((c) => c.key);
      index.columns[qualifiedKey2] = cols;
    }
  }
  return index;
}

// src/background/service-worker.ts
var settingsCache = { value: null };
var graphCache = /* @__PURE__ */ new Map();
async function getSettingsCached() {
  if (!settingsCache.value) settingsCache.value = await getSettings();
  return settingsCache.value;
}
async function getGraphCached(snapshotId) {
  if (graphCache.has(snapshotId)) return graphCache.get(snapshotId);
  const g = await getSchemaGraph(snapshotId);
  if (g) {
    graphCache.set(snapshotId, g);
    return g;
  }
  return null;
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;
  const m = msg;
  void (async () => {
    try {
      const result = await handleMessage(m, sender);
      sendResponse(result);
    } catch (e) {
      sendResponse({ __error: true, message: e?.message ?? String(e) });
    }
  })();
  return true;
});
async function handleMessage(msg, sender) {
  switch (msg.type) {
    // --- Content script ---
    case "pg4:get-active-context": {
      const { origin } = msg;
      const snapshotId = await getActiveSnapshotByOrigin(origin);
      let graph = null;
      let usage = [];
      if (snapshotId) {
        graph = await getGraphCached(snapshotId);
        usage = await getUsageForSnapshot(snapshotId);
      }
      const snippets = await listSnippets();
      return { snapshotId, graph, usage, snippets };
    }
    case "pg4:add-history": {
      const { entry } = msg;
      await addQueryHistory(entry);
      return { ok: true };
    }
    case "pg4:record-usage": {
      const { symbolKey, snapshotId } = msg;
      if (snapshotId && symbolKey) await recordUsage(snapshotId, symbolKey);
      return { ok: true };
    }
    case "pg4:list-snippets": {
      return await listSnippets();
    }
    case "pg4:focus-trigger": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        try {
          await chrome.tabs.sendMessage(tab.id, { type: "pg4:focus-trigger" });
        } catch {
        }
      }
      return { ok: true };
    }
    // --- Options page ---
    case "pg4:import-snapshot": {
      const { displayName, sourceFileName, rawDdl } = msg;
      const snapshotId = `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const result = parseDdl(rawDdl, snapshotId, displayName, sourceFileName);
      const index = buildIndex(result.graph);
      const meta = {
        snapshotId,
        displayName,
        sourceFileName,
        importedAt: (/* @__PURE__ */ new Date()).toISOString(),
        parserVersion: DDL_PARSER_VERSION,
        schemaCount: Object.keys(result.graph.schemas).length,
        relationCount: Object.values(result.graph.schemas).reduce(
          (n, s) => n + Object.keys(s.relations).length,
          0
        ),
        functionCount: result.graph.functions.length,
        warningCount: result.warnings.length,
        rawSizeBytes: rawDdl.length
      };
      const stored = { snapshotId, meta, rawDdl };
      await putSnapshot(stored);
      await putSchemaGraph({ snapshotId, graph: result.graph, index });
      graphCache.set(snapshotId, result.graph);
      return { snapshotId, meta, warnings: result.warnings };
    }
    case "pg4:list-snapshots": {
      return await listSnapshotMetas();
    }
    case "pg4:export-snapshot": {
      const { snapshotId } = msg;
      const row = await getSnapshotRow(snapshotId);
      if (!row) return { __error: true, message: "snapshot not found" };
      const graph = await getSchemaGraph(snapshotId);
      const usage = await getUsageForSnapshot(snapshotId);
      return { snapshot: row, graph, usage };
    }
    case "pg4:delete-snapshot": {
      const { snapshotId } = msg;
      const bindings = await listHostBindings();
      for (const b of bindings) {
        if (b.snapshotId === snapshotId) {
          await setHostBinding(b.origin, null);
          await setActiveSnapshotByOrigin(b.origin, null);
        }
      }
      await deleteSnapshot(snapshotId);
      graphCache.delete(snapshotId);
      await broadcastToAllTabs({ type: "pg4:snapshot-changed" });
      return { ok: true };
    }
    case "pg4:set-host-binding": {
      const { origin, snapshotId } = msg;
      await setHostBinding(origin, snapshotId);
      await setActiveSnapshotByOrigin(origin, snapshotId);
      await broadcastToOrigin(origin, { type: "pg4:snapshot-changed" });
      return { ok: true };
    }
    case "pg4:list-host-bindings": {
      return await listHostBindings();
    }
    case "pg4:get-settings": {
      return await getSettingsCached();
    }
    case "pg4:set-settings": {
      const { patch } = msg;
      const next = await setSettings(patch);
      settingsCache.value = next;
      await broadcastToAllTabs({ type: "pg4:settings-changed" });
      return next;
    }
    case "pg4:save-snippet": {
      const { snippet } = msg;
      await putSnippet(snippet);
      await broadcastToAllTabs({ type: "pg4:snippets-changed" });
      return { ok: true };
    }
    case "pg4:delete-snippet": {
      const { id } = msg;
      await deleteSnippet(id);
      await broadcastToAllTabs({ type: "pg4:snippets-changed" });
      return { ok: true };
    }
    case "pg4:list-history": {
      const opts = msg.opts ?? {};
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
        getAllSnapshotRawSizes()
      ]);
      return {
        usage: est.usage,
        quota: est.quota,
        totalRawDdlBytes: totalRaw,
        snapshots: metas.map((m) => ({ id: m.snapshotId, displayName: m.displayName, rawSizeBytes: m.rawSizeBytes }))
      };
    }
    case "pg4:get-host-allowlist": {
      return await getHostAllowlist();
    }
    case "pg4:set-host-allowlist": {
      const { hosts } = msg;
      await setHostAllowlist(hosts);
      return { ok: true };
    }
    case "pg4:request-host-permission": {
      const { origin } = msg;
      const pattern = origin.endsWith("/") ? `${origin}*` : `${origin}/*`;
      try {
        const granted = await chrome.permissions.request({ origins: [pattern] });
        return { granted };
      } catch (e) {
        return { granted: false, error: e?.message ?? String(e) };
      }
    }
    case "pg4:ping": {
      return { ok: true, version: chrome.runtime.getManifest().version };
    }
    case "pg4:get-graph": {
      const { snapshotId } = msg;
      return await getGraphCached(snapshotId);
    }
    case "pg4:get-graph-with-index": {
      const { snapshotId } = msg;
      return await getSchemaGraphWithIndex(snapshotId);
    }
    default: {
      return { __error: true, message: `unknown message type ${msg.type ?? ""}` };
    }
  }
}
async function broadcastToAllTabs(message) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id) return;
      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch {
      }
    })
  );
}
async function broadcastToOrigin(origin, message) {
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
      }
    })
  );
}
chrome.runtime.onInstalled.addListener(async (details) => {
  await getSettingsCached();
  if (details.reason === "install") {
    console.info("[pg4] installed; default settings initialized.");
  }
});
