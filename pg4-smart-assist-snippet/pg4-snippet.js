/*!
 * PG4 Smart Assist Snippet — single-file DevTools snippet
 * Spec: ../.trae/specs/pg4-snippet-mvp/spec.md
 *
 * Pure native JS (ES2024+), no build step, no dependencies.
 * Paste into DevTools → Sources → Snippets → Ctrl+Enter to run.
 *
 * Algorithm reference: ../src/ (TS MV3 extension), rewritten in plain JS.
 */
(() => {
  "use strict";

  // ┌─────────────────────────────────────────────────────────────────┐
  // │ CONFIG                                                          │
  // └─────────────────────────────────────────────────────────────────┘
  const CONFIG = {
    // "snippet" = manual run in DevTools; "overrides" = auto-injected via Local Overrides
    runMode: "snippet",
    // "auto" = trigger on 2 chars or after . -> ->> #> #>> ; "manual" = Ctrl+Space only
    completionTriggerMode: "auto",
    // "off" | "quotes" = wrap text/uuid/date values in single quotes on paste
    pasteMode: "quotes",
    diagnosticsEnabled: true,
    dangerInterceptEnabled: true,
    maxCandidates: 50,
    // Keyboard shortcut to force-trigger completion. Modifiers: "Ctrl", "Alt", "Shift", "Meta".
    completionShortcut: { ctrl: true, key: " " },
    historyRetentionDays: 30,
    showSystemTables: false,
    // Hover / debounce
    hoverDebounceMs: 350,
    hoverLeaveDelayMs: 150,
    diagnosticsDebounceMs: 300,
    completionDebounceMs: 60,
    // Worker
    workerPingTimeoutMs: 500,
  };

  const PREFIX = "pg4.";
  const DB_NAME = "pg4-smart-assist";
  const DB_VERSION = 1;
  const STORES = {
    snapshots: "snapshots",
    schemaGraphs: "schemaGraphs",
    usage: "usage",
    queryHistory: "queryHistory",
  };
  const MAX_HISTORY_ROWS = 20000;
  const MAX_HISTORY_BYTES = 100 * 1024 * 1024;
  const MAX_TOTAL_DDL_BYTES = 250 * 1024 * 1024;

  const log = (...args) => console.log("[pg4]", ...args);
  const warn = (...args) => console.warn("[pg4]", ...args);
  const error = (...args) => console.error("[pg4]", ...args);

  // ┌─────────────────────────────────────────────────────────────────┐
  // │ Module namespace (single-world, in-memory)                      │
  // └─────────────────────────────────────────────────────────────────┘
  const pg4 = {
    state: {
      activeGraph: null,        // SchemaGraph | null
      activeSnapshotId: null,   // string | null
      editors: new Map(),       // editorId -> EditorSession
      worker: null,             // Worker | null
      workerAvailable: false,
      overlayRoot: null,        // ShadowRoot
      floatingButton: null,
      drawer: null,
      mutationObserver: null,
      storageListeners: new Set(),
    },
  };

  // ┌─────────────────────────────────────────────────────────────────┐
  // │ Stage 1: Storage layer                                          │
  // └─────────────────────────────────────────────────────────────────┘

  let dbPromise = null;
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
        if (!db.objectStoreNames.contains(STORES.usage)) {
          const s = db.createObjectStore(STORES.usage, { keyPath: ["snapshotId", "symbolKey"] });
          s.createIndex("snapshotId", "snapshotId");
        }
        if (!db.objectStoreNames.contains(STORES.queryHistory)) {
          const s = db.createObjectStore(STORES.queryHistory, { keyPath: "id", autoIncrement: true });
          s.createIndex("executedAt", "executedAt");
          s.createIndex("snapshotId", "snapshotId");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function txMany(stores, mode, fn) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      const map = {};
      for (const s of stores) map[s] = t.objectStore(s);
      try { fn(map); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  // Snapshots
  async function putSnapshot(snap) { await tx(STORES.snapshots, "readwrite", s => s.put(snap)); }
  async function getSnapshotRow(id) {
    const row = await tx(STORES.snapshots, "readonly", s => s.get(id));
    return row ?? null;
  }
  async function listSnapshotMetas() {
    const all = await tx(STORES.snapshots, "readonly", s => s.getAll());
    return all.map(r => r.meta).sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1));
  }
  async function deleteSnapshotRow(id) {
    await txMany([STORES.snapshots, STORES.schemaGraphs, STORES.usage], "readwrite", stores => {
      stores[STORES.snapshots].delete(id);
      stores[STORES.schemaGraphs].delete(id);
      const idx = stores[STORES.usage].index("snapshotId");
      idx.openCursor(IDBKeyRange.only(id)).onsuccess = ev => {
        const cursor = ev.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
    });
  }

  // Schema graphs
  async function putSchemaGraphRow(row) { await tx(STORES.schemaGraphs, "readwrite", s => s.put(row)); }
  async function getSchemaGraphRow(id) {
    const row = await tx(STORES.schemaGraphs, "readonly", s => s.get(id));
    return row ?? null;
  }

  // Usage
  async function recordUsage(snapshotId, symbolKey) {
    await txMany([STORES.usage], "readwrite", stores => {
      const key = [snapshotId, symbolKey];
      const getReq = stores[STORES.usage].get(key);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        stores[STORES.usage].put({
          snapshotId, symbolKey,
          frequency: (existing?.frequency ?? 0) + 1,
          lastUsedAt: Date.now(),
        });
      };
    });
  }
  async function getUsageMap(snapshotId) {
    return new Promise((resolve, reject) => {
      openDb().then(db => {
        const t = db.transaction(STORES.usage, "readonly");
        const idx = t.objectStore(STORES.usage).index("snapshotId");
        const req = idx.getAll(IDBKeyRange.only(snapshotId));
        req.onsuccess = () => {
          const map = new Map();
          for (const r of req.result) map.set(r.symbolKey, { frequency: r.frequency, lastUsedAt: r.lastUsedAt });
          resolve(map);
        };
        req.onerror = () => reject(req.error);
      });
    });
  }

  // Query history (write-only, no UI per spec)
  async function addQueryHistory(entry) {
    await new Promise((resolve, reject) => {
      openDb().then(db => {
        const t = db.transaction(STORES.queryHistory, "readwrite");
        const req = t.objectStore(STORES.queryHistory).add(entry);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    });
    pruneHistory().catch(() => {});
  }
  async function pruneHistory() {
    // 1) Retention by age: drop entries older than CONFIG.historyRetentionDays
    if (CONFIG.historyRetentionDays > 0) {
      const cutoff = Date.now() - CONFIG.historyRetentionDays * 24 * 3600 * 1000;
      await new Promise(resolve => {
        openDb().then(db => {
          const t = db.transaction(STORES.queryHistory, "readwrite");
          const idx = t.objectStore(STORES.queryHistory).index("executedAt");
          const range = IDBKeyRange.upperBound(cutoff);
          const req = idx.openCursor(range);
          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) { resolve(); return; }
            cursor.delete(); cursor.continue();
          };
          req.onerror = () => resolve();
        }).catch(() => resolve());
      });
    }
    // 2) Cap by row count (oldest first)
    const count = await tx(STORES.queryHistory, "readonly", s => s.count());
    if (count <= MAX_HISTORY_ROWS) return;
    await new Promise(resolve => {
      openDb().then(db => {
        const t = db.transaction(STORES.queryHistory, "readwrite");
        const idx = t.objectStore(STORES.queryHistory).index("executedAt");
        const toDelete = count - MAX_HISTORY_ROWS;
        let deleted = 0;
        const req = idx.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor || deleted >= toDelete) { resolve(); return; }
          cursor.delete(); deleted++; cursor.continue();
        };
      });
    });
  }

  // localStorage config
  function getActiveSnapshotId() {
    return localStorage.getItem(PREFIX + "activeSnapshotId");
  }
  function setActiveSnapshotId(id) {
    if (id) localStorage.setItem(PREFIX + "activeSnapshotId", id);
    else localStorage.removeItem(PREFIX + "activeSnapshotId");
  }

  // Quota guard for DDL
  async function getAllSnapshotRawSizes() {
    const all = await tx(STORES.snapshots, "readonly", s => s.getAll());
    return all.reduce((sum, s) => sum + (s.rawDdl?.length ?? 0), 0);
  }

  // ┌─────────────────────────────────────────────────────────────────┐
  // │ Stage 2: DDL parsing & schema index                             │
  // └─────────────────────────────────────────────────────────────────┘

  // Identifier folding (PostgreSQL rule: unquoted → lowercase, quoted → case preserved)
  function foldKey(name, quoted) { return quoted ? name : name.toLowerCase(); }

  // --- SQL tokenizer (tolerant, never throws) ---
  const KEYWORD_CHAR_RE = /[A-Za-z0-9_]/;
  const IDENT_START_RE = /[A-Za-z_]/;
  const DIGIT_RE = /[0-9]/;
  const WHITESPACE_RE = /\s/;
  const PUNCTUATION = new Set(["(", ")", ",", ";", ".", "[", "]", ":", "*"]);

  const KEYWORDS = new Set([
    "ALL","ANALYSE","ANALYZE","AND","ANY","ARRAY","AS","ASC","ASYMMETRIC","AUTHORIZATION",
    "BINARY","BOTH","CASE","CAST","CHECK","COLLATE","COLLATION","COLUMN","CONCURRENTLY","CONSTRAINT",
    "CREATE","CROSS","CURRENT_CATALOG","CURRENT_DATE","CURRENT_ROLE","CURRENT_SCHEMA","CURRENT_TIME",
    "CURRENT_TIMESTAMP","CURRENT_USER","DEFAULT","DEFERRABLE","DESC","DISTINCT","DO","ELSE","END",
    "EXCEPT","FALSE","FETCH","FOR","FOREIGN","FREEZE","FROM","FULL","GRANT","GROUP","HAVING",
    "ILIKE","IN","INITIALLY","INNER","INTERSECT","INTO","IS","ISNULL","JOIN","LATERAL","LEADING",
    "LEFT","LIKE","LIMIT","LOCALTIME","LOCALTIMESTAMP","NATURAL","NOT","NOTNULL","NULL","OFFSET",
    "ON","ONLY","OR","ORDER","OUTER","OVERLAPS","PLACING","PRIMARY","REFERENCES","RETURNING",
    "RIGHT","SELECT","SESSION_USER","SIMILAR","SOME","SYMMETRIC","TABLE","TABLESAMPLE","THEN","TO",
    "TRAILING","TRUE","UNION","UNIQUE","USER","USING","VARIADIC","VERBOSE","WHEN","WHERE","WINDOW","WITH",
    "ABORT","ABSOLUTE","ACCESS","ACTION","ADD","ADMIN","AFTER","AGGREGATE","ALSO","ALTER","ALWAYS",
    "ASSERTION","ASSIGNMENT","AT","ATTACH","ATTRIBUTE","BACKWARD","BEFORE","BEGIN","BY","CACHE","CALL",
    "CALLED","CASCADE","CASCADED","CATALOG","CHAIN","CHARACTERISTICS","CHECKPOINT","CLASS","CLOSE","CLUSTER",
    "COLUMNS","COMMENT","COMMENTS","COMMIT","COMMITTED","COMPRESSION","CONFIGURATION","CONFLICT","CONNECTION",
    "CONSTRAINTS","CONTENT","CONTINUE","CONVERSION","COPY","COST","CSV","CUBE","CURRENT","CURSOR","CYCLE",
    "DATA","DATABASE","DAY","DAYS","DEALLOCATE","DECLARE","DEFAULTS","DEFERRED","DEFINER","DELETE",
    "DELIMITER","DELIMITERS","DEPENDS","DETACH","DICTIONARY","DISABLE","DISCARD","DOCUMENT","DOMAIN",
    "DOUBLE","DROP","EACH","ENABLE","ENCODING","ENCRYPTED","ENUM","ESCAPE","EVENT","EXCLUDE","EXCLUDING",
    "EXCLUSIVE","EXECUTE","EXISTS","EXPLAIN","EXPRESSION","EXTENSION","EXTERNAL","FAMILY","FILTER","FIRST",
    "FOLLOWING","FORCE","FORWARD","FUNCTION","FUNCTIONS","GLOBAL","GRANTED","HANDLER","HEADER","HOLD",
    "HOUR","HOURS","IDENTITY","IF","IMMEDIATE","IMMUTABLE","IMPLICIT","IMPORT","INCLUDE","INCLUDING",
    "INCREMENT","INDEX","INDEXES","INHERIT","INHERITS","INLINE","INPUT","INSENSITIVE","INSERT","INSTEAD",
    "INVOKER","ISOLATION","JSON","JSONB","KEY","LABEL","LANGUAGE","LARGE","LAST","LEAKPROOF","LEVEL","LISTEN",
    "LOAD","LOCAL","LOCATION","LOCK","LOCKED","LOGGED","MAPPING","MATCH","MATCHED","MATERIALIZED","MAXVALUE",
    "METHOD","MINUTE","MINUTES","MINVALUE","MODE","MONTH","MONTHS","MOVE","NAME","NAMES","NEW","NEXT","NO",
    "NOTHING","NOTIFY","NOWAIT","NULLS","OBJECT","OF","OFF","OIDS","OLD","OPERATOR","OPTION","OPTIONS","OVER",
    "OVERRIDING","OWNED","OWNER","PARALLEL","PARSER","PARTIAL","PARTITION","PASSING","PASSWORD","PERSISTENT",
    "PLANS","POLICY","PRECEDING","PRECISION","PREPARE","PREPARED","PRESERVE","PRIOR","PRIVILEGES","PROCEDURAL",
    "PROCEDURE","PROCEDURES","PROGRAM","PUBLICATION","QUOTE","RANGE","READ","REAL","REASSIGN","RECHECK",
    "RECURSIVE","REF","REFERENCING","REFRESH","REINDEX","RELATIVE","RELEASE","RENAME","REPEATABLE","REPLACE",
    "REPLICA","RESET","RESTART","RESTRICT","RETURN","REVOKE","ROLE","ROLLBACK","ROLLUP","ROUTINE","ROUTINES",
    "ROW","ROWS","RULE","SAVEPOINT","SCHEMA","SCHEMAS","SCROLL","SEARCH","SECOND","SECONDS","SECRET",
    "SECURITY","SEQUENCE","SEQUENCES","SERIALIZABLE","SERVER","SESSION","SET","SETS","SHARE","SHOW","SIMPLE",
    "SKIP","SNAPSHOT","SQL","STABLE","STANDALONE","START","STATEMENT","STATISTICS","STDIN","STDOUT","STORAGE",
    "STORED","STRICT","STRIP","SUBSCRIPTION","SYSID","SYSTEM","TABLES","TABLESPACE","TEMP","TEMPLATE",
    "TEMPORARY","TEXT","TRANSACTION","TRANSFORM","TRIGGER","TRUNCATE","TRUSTED","TYPE","TYPES","UNBOUNDED",
    "UNCOMMITTED","UNENCRYPTED","UNKNOWN","UNLISTEN","UNLOGGED","UNTIL","UPDATE","VACUUM","VALID","VALIDATE",
    "VALIDATOR","VALUE","VARIABLE","VARYING","VERSION","VIEW","VIEWS","VIRTUAL","VOLATILE","WHITESPACE",
    "WITHIN","WITHOUT","WORK","WRAPPER","WRITE","XML","YEAR","YEARS","YES","ZONE",
  ]);

  function tokenize(sql) {
    const tokens = [];
    let i = 0, line = 1;
    const n = sql.length;
    const push = t => tokens.push(t);

    while (i < n) {
      const ch = sql[i];
      if (ch === "\n") { push({ type: "newline", text: "\n", start: i, end: i + 1, line }); line++; i++; continue; }
      if (WHITESPACE_RE.test(ch)) {
        let j = i + 1;
        while (j < n && WHITESPACE_RE.test(sql[j]) && sql[j] !== "\n") j++;
        push({ type: "whitespace", text: sql.slice(i, j), start: i, end: j, line });
        i = j; continue;
      }
      if (ch === "-" && sql[i + 1] === "-") {
        let j = i + 2;
        while (j < n && sql[j] !== "\n") j++;
        push({ type: "comment-line", text: sql.slice(i, j), start: i, end: j, line });
        i = j; continue;
      }
      if (ch === "/" && sql[i + 1] === "*") {
        let j = i + 2, depth = 1;
        while (j < n && depth > 0) {
          if (sql[j] === "/" && sql[j + 1] === "*") { depth++; j += 2; }
          else if (sql[j] === "*" && sql[j + 1] === "/") { depth--; j += 2; }
          else if (sql[j] === "\n") { line++; j++; }
          else j++;
        }
        push({ type: "comment-block", text: sql.slice(i, j), start: i, end: j, line });
        i = j; continue;
      }
      if (ch === "'") {
        let j = i + 1;
        while (j < n) {
          if (sql[j] === "'") {
            if (sql[j + 1] === "'") { j += 2; continue; }
            j++; break;
          }
          if (sql[j] === "\n") line++;
          j++;
        }
        const text = sql.slice(i, j);
        push({ type: "string", text, start: i, end: j, line, value: text.slice(1, -1).replace(/''/g, "'") });
        i = j; continue;
      }
      if (ch === '"') {
        let j = i + 1;
        while (j < n) {
          if (sql[j] === '"') {
            if (sql[j + 1] === '"') { j += 2; continue; }
            j++; break;
          }
          if (sql[j] === "\n") line++;
          j++;
        }
        const text = sql.slice(i, j);
        const closed = text.endsWith('"');
        push({ type: "quoted-identifier", text, start: i, end: j, line, value: text.slice(1, closed ? -1 : undefined).replace(/""/g, '"') });
        i = j; continue;
      }
      if (ch === "$") {
        const tagMatch = sql.slice(i).match(/^\$[A-Za-z_0-9]*\$/);
        if (tagMatch) {
          const tag = tagMatch[0];
          const closeIdx = sql.indexOf(tag, i + tag.length);
          const j = closeIdx < 0 ? n : closeIdx + tag.length;
          for (let k = i; k < j; k++) if (sql[k] === "\n") line++;
          push({ type: "dollar-quote", text: sql.slice(i, j), start: i, end: j, line, value: tag });
          i = j; continue;
        }
      }
      if (DIGIT_RE.test(ch) || (ch === "." && DIGIT_RE.test(sql[i + 1] ?? ""))) {
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
        i = j; continue;
      }
      if (IDENT_START_RE.test(ch)) {
        let j = i + 1;
        while (j < n && KEYWORD_CHAR_RE.test(sql[j])) j++;
        const text = sql.slice(i, j);
        const upper = text.toUpperCase();
        push({ type: KEYWORDS.has(upper) ? "keyword" : "identifier", text, start: i, end: j, line, value: text });
        i = j; continue;
      }
      if (ch === "-" && sql[i + 1] === ">") {
        const len = sql[i + 2] === ">" ? 3 : 2;
        push({ type: "operator", text: sql.slice(i, i + len), start: i, end: i + len, line });
        i += len; continue;
      }
      if (ch === "#" && sql[i + 1] === ">") {
        const len = sql[i + 2] === ">" ? 3 : 2;
        push({ type: "operator", text: sql.slice(i, i + len), start: i, end: i + len, line });
        i += len; continue;
      }
      if ("<>!=".includes(ch)) {
        let len = 1;
        if (sql[i + 1] === "=") len = 2;
        if ((ch === "<" && sql[i + 1] === ">") || (ch === "!" && sql[i + 1] === "=")) len = 2;
        push({ type: "operator", text: sql.slice(i, i + len), start: i, end: i + len, line });
        i += len; continue;
      }
      if (ch === "|" && sql[i + 1] === "|") { push({ type: "operator", text: "||", start: i, end: i + 2, line }); i += 2; continue; }
      if (ch === ":" && sql[i + 1] === ":") { push({ type: "operator", text: "::", start: i, end: i + 2, line }); i += 2; continue; }
      if (PUNCTUATION.has(ch)) { push({ type: "punctuation", text: ch, start: i, end: i + 1, line }); i++; continue; }
      if ("+-*/%<>=~&|^@?".includes(ch)) { push({ type: "operator", text: ch, start: i, end: i + 1, line }); i++; continue; }
      push({ type: "punctuation", text: ch, start: i, end: i + 1, line }); i++;
    }
    push({ type: "eof", text: "", start: n, end: n, line });
    return tokens;
  }

  function significantTokens(tokens) {
    return tokens.filter(t =>
      t.type !== "whitespace" && t.type !== "newline" &&
      t.type !== "comment-line" && t.type !== "comment-block"
    );
  }

  function splitStatements(tokens) {
    const out = [];
    let cur = [];
    let depth = 0;
    for (const t of tokens) {
      if (t.type === "eof") {
        if (cur.length) { out.push(cur); cur = []; }
        break;
      }
      if (t.type === "punctuation" && t.text === "(") depth++;
      else if (t.type === "punctuation" && t.text === ")") depth = Math.max(0, depth - 1);
      if (t.type === "punctuation" && t.text === ";" && depth === 0) {
        if (cur.length) out.push(cur);
        cur = [];
      } else cur.push(t);
    }
    if (cur.length) out.push(cur);
    return out;
  }

  // --- DDL parser ---
  const PARSER_VERSION = 1;

  function parseDdl(rawDdl, sourceFileName = "<inline>") {
    const warnings = [];
    const graph = {
      snapshotId: null, // filled by caller
      displayName: null,
      sourceFileName,
      importedAt: new Date().toISOString(),
      parserVersion: PARSER_VERSION,
      schemas: {},
      functions: [],
    };
    const ensureSchema = (name, quoted) => {
      const key = foldKey(name, quoted);
      if (!graph.schemas[key]) {
        graph.schemas[key] = { name, key, quoted: !!quoted, relations: {} };
      }
      return graph.schemas[key];
    };

    const tokens = tokenize(rawDdl);
    const stmts = splitStatements(tokens);

    for (const stmt of stmts) {
      const sig = significantTokens(stmt);
      if (!sig.length) continue;
      try {
        parseStatement(sig, graph, ensureSchema, warnings, stmt);
      } catch (e) {
        const first = sig[0];
        warnings.push({
          line: first?.line ?? 1,
          code: "PARSE_ERROR",
          message: String(e?.message || e),
          summary: sig.slice(0, 4).map(t => t.text).join(" "),
        });
      }
    }
    return { graph, warnings };
  }

  function parseStatement(sig, graph, ensureSchema, warnings, rawStmt) {
    // Look for leading comment-block annotations on the previous raw token
    // (JSONB annotations handled in jsonb-parser pass)
    const head = sig[0];
    if (head?.type !== "keyword" && head?.type !== "identifier") {
      // Unknown statement kind; record warning but don't block import
      warnings.push({
        line: head?.line ?? 1,
        code: "UNKNOWN_STMT",
        message: "Unrecognized statement",
        summary: sig.slice(0, 4).map(t => t.text).join(" "),
      });
      return;
    }
    const headText = head.text.toUpperCase();
    switch (headText) {
      case "CREATE": parseCreate(sig, graph, ensureSchema, warnings); break;
      case "ALTER": parseAlter(sig, graph, ensureSchema, warnings); break;
      case "COMMENT": parseComment(sig, graph, ensureSchema); break;
      default:
        // Other statements (INSERT, SELECT in DDL file, etc.) — ignore silently
        break;
    }
  }

  // Helper: read schema-qualified name starting at index; returns {schema, name, schemaQuoted, nameQuoted, next}
  function readQualifiedName(sig, idx) {
    let i = idx;
    const readIdent = () => {
      const t = sig[i];
      if (!t) return null;
      if (t.type === "identifier") { i++; return { name: t.value, quoted: false }; }
      if (t.type === "quoted-identifier") { i++; return { name: t.value, quoted: true }; }
      if (t.type === "keyword") { // allow keywords as identifiers in DDL positions
        i++;
        return { name: t.text, quoted: false };
      }
      return null;
    };
    const first = readIdent();
    if (!first) return null;
    if (sig[i]?.type === "punctuation" && sig[i].text === ".") {
      i++;
      const second = readIdent();
      if (!second) return { schema: first.name, schemaQuoted: first.quoted, name: null, nameQuoted: false, next: i };
      return { schema: first.name, schemaQuoted: first.quoted, name: second.name, nameQuoted: second.quoted, next: i };
    }
    return { schema: null, schemaQuoted: false, name: first.name, nameQuoted: first.quoted, next: i };
  }

  function parseCreate(sig, graph, ensureSchema, warnings) {
    let i = 1;
    // Skip OR REPLACE
    if (sig[i]?.type === "keyword" && sig[i].text.toUpperCase() === "OR") {
      i++; // OR
      if (sig[i]?.type === "keyword" && sig[i].text.toUpperCase() === "REPLACE") i++;
    }
    const kindTok = sig[i++];
    if (!kindTok) return;
    const kind = kindTok.text.toUpperCase();
    switch (kind) {
      case "SCHEMA": parseCreateSchema(sig, i, ensureSchema); break;
      case "TABLE": parseCreateTable(sig, i, graph, ensureSchema, warnings); break;
      case "VIEW":
      case "MATERIALIZED": parseCreateView(sig, i, graph, ensureSchema, kind); break;
      case "FOREIGN": parseCreateForeignTable(sig, i, graph, ensureSchema); break;
      case "FUNCTION":
      case "PROCEDURE": parseCreateFunction(sig, i, graph, ensureSchema, kind); break;
      case "INDEX": parseCreateIndex(sig, i, graph, ensureSchema, warnings, false); break;
      case "UNIQUE":
        if (sig[i]?.text.toUpperCase() === "INDEX") parseCreateIndex(sig, i + 1, graph, ensureSchema, warnings, true);
        break;
      default: break; // other CREATE kinds ignored
    }
  }

  function parseCreateSchema(sig, i, ensureSchema) {
    const qn = readQualifiedName(sig, i);
    if (!qn?.name) return;
    ensureSchema(qn.name, qn.nameQuoted);
  }

  function parseCreateTable(sig, i, graph, ensureSchema, warnings) {
    const qn = readQualifiedName(sig, i);
    if (!qn?.name) return;
    let next = qn.next;
    const schemaName = qn.schema || "public";
    const schemaQuoted = qn.schemaQuoted || false;
    const schema = ensureSchema(schemaName, schemaQuoted);
    const relKey = `${foldKey(schemaName, schemaQuoted)}.${foldKey(qn.name, qn.nameQuoted)}`;
    // Prevent duplicate relation entries from overwriting (first wins; later are warnings)
    if (schema.relations[relKey]) {
      warnings.push({ line: sig[0].line, code: "DUP_TABLE", message: `Duplicate table: ${relKey}`, summary: sig.slice(0, 4).map(t => t.text).join(" ") });
    }
    const table = {
      kind: "table",
      schema: schemaName, name: qn.name,
      key: relKey, quoted: qn.nameQuoted,
      columns: [], primaryKey: [], foreignKeys: [], indexes: [],
    };
    schema.relations[relKey] = table;

    // Expect '(' next
    if (!(sig[next]?.type === "punctuation" && sig[next].text === "(")) return;
    next++;
    // Parse column/constraint list until matching ')'
    let depth = 1;
    let colOrdinal = 0;
    while (next < sig.length && depth > 0) {
      const t = sig[next];
      if (t.type === "punctuation" && t.text === "(") { depth++; next++; continue; }
      if (t.type === "punctuation" && t.text === ")") { depth--; next++; continue; }
      if (t.type === "punctuation" && t.text === ",") { next++; continue; }

      // Check if this is a table-level constraint
      if (t.type === "keyword" && t.text.toUpperCase() === "CONSTRAINT") {
        next = parseTableConstraint(sig, next, table);
        continue;
      }
      if (t.type === "keyword" && ["PRIMARY","FOREIGN","UNIQUE","CHECK","EXCLUDE"].includes(t.text.toUpperCase())) {
        next = parseTableConstraint(sig, next, table, /*named=*/false);
        continue;
      }
      // Otherwise: column definition
      const col = parseColumnDef(sig, next, colOrdinal++);
      if (col) {
        table.columns.push(col);
        if (col.isPrimaryKey && !table.primaryKey.includes(col.key)) table.primaryKey.push(col.key);
        next = col.next ?? next + 1;
      } else {
        next++; // skip unknown token
      }
    }
  }

  function parseColumnDef(sig, i, ordinal) {
    const nameTok = sig[i];
    if (!nameTok) return null;
    if (nameTok.type !== "identifier" && nameTok.type !== "quoted-identifier" && nameTok.type !== "keyword") return null;
    const name = nameTok.value ?? nameTok.text;
    const quoted = nameTok.type === "quoted-identifier";
    i++;
    // Read type tokens until top-level ',' / ')' or a constraint keyword.
    // Paren depth is tracked so `numeric(10,2)` / `varchar(255)` stay intact.
    const typeParts = [];
    let parenDepth = 0;
    while (i < sig.length) {
      const t = sig[i];
      if (t.type === "punctuation") {
        if (t.text === "(") { parenDepth++; typeParts.push(t.text); i++; continue; }
        if (t.text === ")") {
          if (parenDepth === 0) break; // end of column list
          parenDepth--;
          typeParts.push(t.text); i++; continue;
        }
        if (t.text === "," && parenDepth === 0) break; // next column
      }
      if (parenDepth === 0 && t.type === "keyword" && ["NOT","NULL","DEFAULT","PRIMARY","UNIQUE","REFERENCES","CHECK","GENERATED","COLLATE","CONSTRAINT"].includes(t.text.toUpperCase())) break;
      typeParts.push(t.text);
      i++;
    }
    const dataType = typeParts.join("").replace(/\s+/g, " ").trim();
    const baseType = normalizeBaseType(dataType);
    const col = {
      name, key: foldKey(name, quoted), quoted,
      dataType, baseType, nullable: true, ordinal,
      isPrimaryKey: false,
    };
    // Parse column constraints
    while (i < sig.length) {
      const t = sig[i];
      if (t.type === "punctuation" && (t.text === "," || t.text === ")")) break;
      if (t.type !== "keyword") { i++; continue; }
      const up = t.text.toUpperCase();
      if (up === "NOT") {
        i++;
        if (sig[i]?.text.toUpperCase() === "NULL") { col.nullable = false; i++; }
      } else if (up === "NULL") {
        col.nullable = true; i++;
      } else if (up === "DEFAULT") {
        i++;
        // capture default expression until next constraint keyword or ,/)
        const defParts = [];
        let d = 0;
        while (i < sig.length) {
          const dt = sig[i];
          if (dt.type === "punctuation" && dt.text === "(") d++;
          else if (dt.type === "punctuation" && dt.text === ")") { if (d === 0) break; d--; }
          else if (d === 0 && dt.type === "punctuation" && (dt.text === "," )) break;
          else if (d === 0 && dt.type === "keyword" && ["NOT","NULL","PRIMARY","UNIQUE","REFERENCES","CHECK","GENERATED","COLLATE","CONSTRAINT"].includes(dt.text.toUpperCase())) break;
          defParts.push(dt.text);
          i++;
        }
        col.defaultExpression = defParts.join("").replace(/\s+/g, " ").trim();
      } else if (up === "PRIMARY") {
        i++;
        if (sig[i]?.text.toUpperCase() === "KEY") { col.isPrimaryKey = true; col.nullable = false; i++; }
      } else if (up === "UNIQUE") {
        i++;
      } else if (up === "REFERENCES") {
        i++;
        const ref = readQualifiedName(sig, i);
        if (ref?.name) {
          i = ref.next;
          // optional (col, col...)
          if (sig[i]?.text === "(") {
            i++;
            while (i < sig.length && sig[i].text !== ")") i++;
            if (sig[i]?.text === ")") i++;
          }
          col.foreignKey = {
            localColumns: [col.key],
            referencedSchema: ref.schema || "public",
            referencedTable: ref.name,
            referencedColumns: [],
          };
        }
      } else if (up === "CHECK") {
        i++;
        // skip until matching ) at depth 0 of column — best effort
        if (sig[i]?.text === "(") {
          let d = 1; i++;
          while (i < sig.length && d > 0) {
            if (sig[i].text === "(") d++;
            else if (sig[i].text === ")") d--;
            i++;
          }
        }
      } else if (up === "COLLATE") {
        i++; if (i < sig.length) i++;
      } else if (up === "GENERATED") {
        // skip until next comma/) at depth 0
        while (i < sig.length) {
          const dt = sig[i];
          if (dt.type === "punctuation" && (dt.text === "," || dt.text === ")")) break;
          i++;
        }
      } else if (up === "CONSTRAINT") {
        i++; if (i < sig.length) i++; // constraint name
      } else {
        i++;
      }
    }
    col.next = i;
    return col;
  }

  function parseTableConstraint(sig, i, table, named = true) {
    if (sig[i]?.text.toUpperCase() === "CONSTRAINT") {
      i++; // CONSTRAINT
      if (i < sig.length) i++; // constraint name
    }
    const kw = sig[i]?.text.toUpperCase();
    if (kw === "PRIMARY" && sig[i + 1]?.text.toUpperCase() === "KEY") {
      i += 2;
      // ( col, col, ... )
      if (sig[i]?.text === "(") {
        i++;
        const cols = [];
        while (i < sig.length && sig[i].text !== ")") {
          if (sig[i].type === "identifier" || sig[i].type === "quoted-identifier") {
            cols.push(foldKey(sig[i].value ?? sig[i].text, sig[i].type === "quoted-identifier"));
          }
          i++;
        }
        if (sig[i]?.text === ")") i++;
        table.primaryKey = cols;
        for (const c of table.columns) {
          if (cols.includes(c.key)) { c.isPrimaryKey = true; c.nullable = false; }
        }
      }
    } else if (kw === "FOREIGN" && sig[i + 1]?.text.toUpperCase() === "KEY") {
      i += 2;
      let localCols = [];
      if (sig[i]?.text === "(") {
        i++;
        while (i < sig.length && sig[i].text !== ")") {
          if (sig[i].type === "identifier" || sig[i].type === "quoted-identifier") {
            localCols.push(foldKey(sig[i].value ?? sig[i].text, sig[i].type === "quoted-identifier"));
          }
          i++;
        }
        if (sig[i]?.text === ")") i++;
      }
      if (sig[i]?.text.toUpperCase() === "REFERENCES") {
        i++;
        const ref = readQualifiedName(sig, i);
        if (ref?.name) {
          i = ref.next;
          let refCols = [];
          if (sig[i]?.text === "(") {
            i++;
            while (i < sig.length && sig[i].text !== ")") {
              if (sig[i].type === "identifier" || sig[i].type === "quoted-identifier") {
                refCols.push(foldKey(sig[i].value ?? sig[i].text, sig[i].type === "quoted-identifier"));
              }
              i++;
            }
            if (sig[i]?.text === ")") i++;
          }
          table.foreignKeys.push({
            localColumns: localCols,
            referencedSchema: ref.schema || "public",
            referencedTable: ref.name,
            referencedColumns: refCols,
          });
        }
      }
    } else if (kw === "UNIQUE") {
      i++;
      // skip (cols)
      if (sig[i]?.text === "(") {
        let d = 1; i++;
        while (i < sig.length && d > 0) {
          if (sig[i].text === "(") d++;
          else if (sig[i].text === ")") d--;
          i++;
        }
      }
    } else if (kw === "CHECK" || kw === "EXCLUDE") {
      i++;
      if (sig[i]?.text === "(") {
        let d = 1; i++;
        while (i < sig.length && d > 0) {
          if (sig[i].text === "(") d++;
          else if (sig[i].text === ")") d--;
          i++;
        }
      }
    } else {
      i++;
    }
    return i;
  }

  function parseCreateView(sig, i, graph, ensureSchema, kind) {
    // Handle "MATERIALIZED VIEW" — kind is "MATERIALIZED" here
    if (kind === "MATERIALIZED") {
      if (sig[i]?.text.toUpperCase() !== "VIEW") return;
      i++;
    }
    const qn = readQualifiedName(sig, i);
    if (!qn?.name) return;
    const schemaName = qn.schema || "public";
    const schema = ensureSchema(schemaName, qn.schemaQuoted || false);
    const relKey = `${foldKey(schemaName, qn.schemaQuoted || false)}.${foldKey(qn.name, qn.nameQuoted)}`;
    schema.relations[relKey] = {
      kind: kind === "MATERIALIZED" ? "materialized-view" : "view",
      schema: schemaName, name: qn.name, key: relKey, quoted: qn.nameQuoted,
      columns: [], primaryKey: [], foreignKeys: [], indexes: [],
    };
  }

  function parseCreateForeignTable(sig, i, graph, ensureSchema) {
    if (sig[i]?.text.toUpperCase() !== "TABLE") return;
    i++;
    const qn = readQualifiedName(sig, i);
    if (!qn?.name) return;
    const schemaName = qn.schema || "public";
    const schema = ensureSchema(schemaName, qn.schemaQuoted || false);
    const relKey = `${foldKey(schemaName, qn.schemaQuoted || false)}.${foldKey(qn.name, qn.nameQuoted)}`;
    schema.relations[relKey] = {
      kind: "foreign-table",
      schema: schemaName, name: qn.name, key: relKey, quoted: qn.nameQuoted,
      columns: [], primaryKey: [], foreignKeys: [], indexes: [],
    };
  }

  function parseCreateFunction(sig, i, graph, ensureSchema, kind) {
    const qn = readQualifiedName(sig, i);
    if (!qn?.name) return;
    i = qn.next;
    const schemaName = qn.schema || "public";
    const func = {
      schema: schemaName, name: qn.name,
      key: `${foldKey(schemaName, qn.schemaQuoted || false)}.${foldKey(qn.name, qn.nameQuoted)}`,
      args: [], returnType: "", language: undefined, quoted: qn.nameQuoted,
    };
    // Parse args ( ... )
    if (sig[i]?.text === "(") {
      i++;
      let depth = 1;
      let cur = { mode: "in", dataType: "" };
      const parts = [];
      while (i < sig.length && depth > 0) {
        const t = sig[i];
        if (t.text === "(") { depth++; parts.push(t.text); i++; continue; }
        if (t.text === ")") { depth--; if (depth === 0) { i++; break; } parts.push(t.text); i++; continue; }
        if (t.text === ",") {
          if (parts.length) {
            func.args.push({ ...cur, dataType: parts.join("").replace(/\s+/g, " ").trim() });
          }
          parts.length = 0;
          cur = { mode: "in", dataType: "" };
          i++; continue;
        }
        const up = t.text?.toUpperCase();
        if (t.type === "keyword" && (up === "IN" || up === "OUT" || up === "INOUT" || up === "VARIADIC")) {
          cur.mode = up.toLowerCase();
          i++; continue;
        }
        parts.push(t.text);
        i++;
      }
      if (parts.length) {
        func.args.push({ ...cur, dataType: parts.join("").replace(/\s+/g, " ").trim() });
      }
    }
    // Find RETURNS clause
    while (i < sig.length) {
      if (sig[i].type === "keyword" && sig[i].text.toUpperCase() === "RETURNS") {
        i++;
        const rtParts = [];
        while (i < sig.length) {
          const t = sig[i];
          if (t.type === "keyword" && ["LANGUAGE","AS","BEGIN","RETURN","SECURITY"].includes(t.text.toUpperCase())) break;
          if (t.type === "punctuation" && t.text === "," ) break;
          rtParts.push(t.text);
          i++;
        }
        func.returnType = rtParts.join("").replace(/\s+/g, " ").trim();
        break;
      }
      i++;
    }
    // Find LANGUAGE
    while (i < sig.length) {
      if (sig[i].type === "keyword" && sig[i].text.toUpperCase() === "LANGUAGE") {
        i++;
        if (i < sig.length) func.language = sig[i].text;
        break;
      }
      i++;
    }
    ensureSchema(schemaName, qn.schemaQuoted || false);
    graph.functions.push(func);
  }

  // CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] name ON [schema.]table [USING method] (cols)
  function parseCreateIndex(sig, i, graph, ensureSchema, warnings, unique) {
    if (sig[i]?.text.toUpperCase() === "CONCURRENTLY") i++;
    if (sig[i]?.text.toUpperCase() === "IF" &&
        sig[i + 1]?.text.toUpperCase() === "NOT" &&
        sig[i + 2]?.text.toUpperCase() === "EXISTS") i += 3;
    // optional index name
    let indexName = null;
    if (sig[i]?.type === "identifier" || sig[i]?.type === "quoted-identifier") {
      indexName = sig[i].value ?? sig[i].text;
      i++;
    }
    if (sig[i]?.text.toUpperCase() !== "ON") return;
    i++;
    const qn = readQualifiedName(sig, i);
    if (!qn?.name) return;
    i = qn.next;
    if (sig[i]?.text.toUpperCase() === "USING") i += 2; // USING method
    const cols = [];
    if (sig[i]?.text === "(") {
      i++;
      let depth = 1;
      while (i < sig.length && depth > 0) {
        const t = sig[i];
        if (t.text === "(") depth++;
        else if (t.text === ")") { depth--; if (depth === 0) break; }
        else if (t.type === "identifier" || t.type === "quoted-identifier") {
          cols.push(foldKey(t.value ?? t.text, t.type === "quoted-identifier"));
        }
        i++;
      }
    }
    const isPartial = sig.slice(i).some(t => t.type === "keyword" && t.text.toUpperCase() === "WHERE");
    const schemaName = qn.schema || "public";
    const schemaKey = foldKey(schemaName, qn.schemaQuoted || false);
    const relKey = `${schemaKey}.${foldKey(qn.name, qn.nameQuoted)}`;
    const schema = ensureSchema(schemaName, qn.schemaQuoted || false);
    const rel = schema.relations[relKey];
    if (!rel) {
      warnings.push({
        line: sig[0].line,
        code: "INDEX_TARGET_MISSING",
        message: `CREATE INDEX on unknown table ${schemaName}.${qn.name}`,
        summary: sig.slice(0, 5).map(t => t.text).join(" "),
      });
      return;
    }
    rel.indexes.push({ name: indexName ?? `__index_${rel.indexes.length}`, columns: cols, unique: !!unique, partial: isPartial });
  }

  function parseAlter(sig, graph, ensureSchema, warnings) {
    let i = 1;
    if (sig[i]?.text.toUpperCase() === "TABLE") {
      i++;
      const qn = readQualifiedName(sig, i);
      if (!qn?.name) return;
      i = qn.next;
      const schemaName = qn.schema || "public";
      const relKey = `${foldKey(schemaName, qn.schemaQuoted || false)}.${foldKey(qn.name, qn.nameQuoted)}`;
      const schema = ensureSchema(schemaName, qn.schemaQuoted || false);
      let table = schema.relations[relKey];
      if (!table) {
        // ALTER TABLE on unknown table — create stub
        table = { kind: "table", schema: schemaName, name: qn.name, key: relKey, quoted: qn.nameQuoted, columns: [], primaryKey: [], foreignKeys: [], indexes: [] };
        schema.relations[relKey] = table;
      }
      // Parse ALTER actions
      while (i < sig.length) {
        const up = sig[i]?.text?.toUpperCase();
        if (up === "ADD") {
          i++;
          if (sig[i]?.text.toUpperCase() === "CONSTRAINT") i++;
          // Parse like a table constraint
          i = parseTableConstraint(sig, i, table, false);
        } else if (up === "DROP") {
          // best effort skip
          while (i < sig.length && sig[i].text !== ",") i++;
        } else if (up === "ALTER" || up === "RENAME") {
          while (i < sig.length && sig[i].text !== ",") i++;
        } else {
          i++;
        }
        if (sig[i]?.text === ",") i++;
      }
    }
  }

  // Read a dotted identifier chain (up to maxParts), e.g. schema.table.column.
  function readDottedChain(sig, i, maxParts = 3) {
    const parts = [];
    while (parts.length < maxParts) {
      const t = sig[i];
      if (t?.type === "identifier") { parts.push({ name: t.value, quoted: false }); i++; }
      else if (t?.type === "quoted-identifier") { parts.push({ name: t.value, quoted: true }); i++; }
      else if (t?.type === "keyword" && parts.length === 0) { parts.push({ name: t.text, quoted: false }); i++; } // allow keyword as leading identifier
      else break;
      if (sig[i]?.type === "punctuation" && sig[i].text === ".") { i++; continue; }
      break;
    }
    return { parts, next: i };
  }

  function parseComment(sig, graph, ensureSchema) {
    let i = 1;
    if (sig[i]?.text.toUpperCase() !== "ON") return;
    i++;
    // Object kind: TABLE | VIEW | MATERIALIZED VIEW | COLUMN | ...
    let kind = sig[i]?.text.toUpperCase();
    i++;
    if (kind === "MATERIALIZED" && sig[i]?.text.toUpperCase() === "VIEW") {
      kind = "MATERIALIZED VIEW";
      i++;
    }
    // Dotted chain: schema.table.column for COLUMN, schema.name otherwise
    const chain = readDottedChain(sig, i, kind === "COLUMN" ? 3 : 2);
    const parts = chain.parts;
    if (!parts.length) return;
    i = chain.next;
    // Find IS 'text'
    let comment = null;
    while (i < sig.length) {
      if (sig[i].type === "keyword" && sig[i].text.toUpperCase() === "IS") {
        i++;
        if (sig[i]?.type === "string") comment = sig[i].value;
        else if (sig[i]?.text.toUpperCase() === "NULL") comment = null;
        break;
      }
      i++;
    }
    if (comment == null) return;

    if (kind === "COLUMN") {
      let schemaPart, tablePart, colPart;
      if (parts.length >= 3) {
        [schemaPart, tablePart, colPart] = parts;
      } else if (parts.length === 2) {
        schemaPart = { name: "public", quoted: false };
        [tablePart, colPart] = parts;
      } else {
        return;
      }
      const schemaKey = foldKey(schemaPart.name, schemaPart.quoted);
      const schema = graph.schemas[schemaKey];
      if (!schema) return;
      const relKey = `${schemaKey}.${foldKey(tablePart.name, tablePart.quoted)}`;
      const rel = schema.relations[relKey];
      if (!rel) return;
      const colKey = foldKey(colPart.name, colPart.quoted);
      const col = rel.columns.find(c => c.key === colKey);
      if (col) col.comment = comment;
      return;
    }

    if (kind === "TABLE" || kind === "VIEW" || kind === "MATERIALIZED VIEW") {
      const schemaPart = parts.length >= 2 ? parts[0] : { name: "public", quoted: false };
      const namePart = parts.length >= 2 ? parts[1] : parts[0];
      const schemaKey = foldKey(schemaPart.name, schemaPart.quoted);
      const schema = graph.schemas[schemaKey];
      if (!schema) return;
      const relKey = `${schemaKey}.${foldKey(namePart.name, namePart.quoted)}`;
      if (schema.relations[relKey]) schema.relations[relKey].comment = comment;
    }
  }

  function normalizeBaseType(dataType) {
    if (!dataType) return "";
    let t = dataType.toLowerCase();
    // strip length/precision: varchar(255) -> varchar, numeric(10,2) -> numeric
    t = t.replace(/\s*\([^)]*\)\s*/g, "").trim();
    // strip array suffix []
    t = t.replace(/\[\s*\]$/, "").trim();
    // Common aliases
    const aliases = {
      int: "integer", int4: "integer", int8: "bigint", int2: "smallint",
      bool: "boolean", float4: "real", float8: "double precision",
      decimal: "numeric", string: "text",
    };
    return aliases[t] ?? t;
  }

  // --- JSONB annotation parser ---
  // Two path notations supported:
  //   1. dotted: customer.name / items[].price  ([] marks an array segment)
  //   2. JSON Pointer: /customer/name  (~1 = "/", ~0 = "~")
  function parseJsonbPathSegments(pathStr) {
    if (pathStr.startsWith("/")) {
      return pathStr.split("/").slice(1)
        .map(p => p.replace(/~1/g, "/").replace(/~0/g, "~"))
        .filter(s => s !== "" && s !== "-");
    }
    return pathStr.split(".").filter(Boolean);
  }

  function parseJsonbAnnotations(rawDdl, graph) {
    // Pattern: -- @pg4-jsonb schema.table.column path:type "comment"
    const re = /--\s*@pg4-jsonb\s+([^\s]+)\s+([^\s]+)(?:\s+"([^"]*)")?/g;
    let m;
    while ((m = re.exec(rawDdl)) !== null) {
      const target = m[1];
      const pathSpec = m[2];
      const comment = m[3];
      // target = schema.table.column
      const parts = target.split(".");
      if (parts.length < 3) continue;
      const schemaKey = foldKey(parts[0], false);
      const relKey = `${schemaKey}.${foldKey(parts[1], false)}`;
      const colKey = foldKey(parts[2], false);
      const schema = graph.schemas[schemaKey];
      const rel = schema?.relations[relKey];
      const col = rel?.columns.find(c => c.key === colKey);
      if (!col) continue;
      // pathSpec: "customer.name:string" or "items[].price:number" or "/a/b:type"
      const lastColon = pathSpec.lastIndexOf(":");
      const pathStr = lastColon >= 0 ? pathSpec.slice(0, lastColon) : pathSpec;
      const valueType = lastColon >= 0 ? pathSpec.slice(lastColon + 1) : undefined;
      const segs = parseJsonbPathSegments(pathStr);
      if (!segs.length) continue;
      const isArray = segs.some(s => s.endsWith("[]"));
      const cleanSegs = segs.map(s => s.endsWith("[]") ? s.slice(0, -2) : s);
      const node = {
        segments: cleanSegs,
        displayPath: cleanSegs.join("."),
        isArray, valueType, comment,
        children: [],
      };
      if (!col.jsonbPaths) col.jsonbPaths = [];
      col.jsonbPaths.push(node);
    }
  }

  // --- Schema index builder ---
  function buildIndex(graph) {
    const idx = {
      relations: {},         // lowercased name (no schema) -> ["schema.rel", ...]
      relationByName: {},    // lowercased "schema.rel" -> relNode
      columns: {},           // "schema.rel" -> [colKey]
      columnsByRelation: {}, // "schema.rel" -> [colNode]
      schemas: {},           // schemaKey -> schemaNode
    };
    for (const sk of Object.keys(graph.schemas)) {
      const schema = graph.schemas[sk];
      idx.schemas[sk] = schema;
      for (const rk of Object.keys(schema.relations)) {
        const rel = schema.relations[rk];
        idx.relationByName[rk] = rel;
        const nameOnly = rk.split(".")[1];
        if (!idx.relations[nameOnly]) idx.relations[nameOnly] = [];
        idx.relations[nameOnly].push(rk);
        idx.columns[rk] = rel.columns.map(c => c.key);
        idx.columnsByRelation[rk] = rel.columns;
      }
    }
    graph._index = idx;
    return idx;
  }

  // ┌─────────────────────────────────────────────────────────────────┐
  // │ Stage 3: Context parser & completion engine                     │
  // └─────────────────────────────────────────────────────────────────┘

  // Locate the statement containing the cursor. Returns {tokens, start, end}.
  function findStatementAtCursor(allSig, cursor) {
    if (!allSig.length) return null;
    const spans = [];
    let cur = [];
    let depth = 0;
    let stmtStart = allSig[0].start;
    for (const t of allSig) {
      if (t.type === "eof") {
        if (cur.length) spans.push({ start: stmtStart, end: t.start, tokens: cur });
        break;
      }
      if (t.type === "punctuation" && t.text === "(") depth++;
      else if (t.type === "punctuation" && t.text === ")") depth = Math.max(0, depth - 1);
      if (t.type === "punctuation" && t.text === ";" && depth === 0) {
        if (cur.length) spans.push({ start: stmtStart, end: t.end, tokens: cur });
        cur = [];
        stmtStart = t.end + 1;
      } else {
        if (cur.length === 0) stmtStart = t.start;
        cur.push(t);
      }
    }
    if (cur.length) spans.push({ start: stmtStart, end: allSig[allSig.length - 1].end, tokens: cur });
    for (const span of spans) {
      if (cursor >= span.start && cursor <= span.end + 1) return span;
    }
    return spans[spans.length - 1] ?? null;
  }

  // Build relation map from a statement: tables/views/CTEs/aliases in scope.
  function buildRelationMap(stmtTokens, graph) {
    const visible = [];
    const byAlias = new Map();
    const byName = new Map();
    let activeAlias = null;
    let activeSchema = null;
    let expectedTypes = null;

    // Track WITH ... AS (CTE) names
    for (let i = 0; i < stmtTokens.length; i++) {
      const t = stmtTokens[i];
      const up = t.text?.toUpperCase();
      if (t.type === "keyword" && up === "WITH") {
        // Read CTE names: name AS (
        let j = i + 1;
        while (j < stmtTokens.length) {
          const nt = stmtTokens[j];
          if (nt.type === "keyword" && nt.text.toUpperCase() === "SELECT") break;
          if (nt.type === "identifier" || nt.type === "quoted-identifier") {
            const cteName = nt.value ?? nt.text;
            const cteQuoted = nt.type === "quoted-identifier";
            // Look ahead for AS (
            let k = j + 1;
            while (k < stmtTokens.length && stmtTokens[k].type === "whitespace") k++;
            if (stmtTokens[k]?.text.toUpperCase() === "AS") {
              k++;
              if (stmtTokens[k]?.text === "(") {
                // Register CTE as a visible relation
                const ref = {
                  key: foldKey(cteName, cteQuoted),
                  name: cteName,
                  alias: cteName,
                  cteName,
                  columns: [],
                };
                visible.push(ref);
                byAlias.set(foldKey(cteName, cteQuoted), ref);
                byName.set(foldKey(cteName, cteQuoted), ref);
              }
            }
          }
          j++;
        }
      }
    }

    // Track FROM/JOIN/INTO/UPDATE relations
    const RELATION_KEYWORDS = new Set(["FROM", "JOIN", "INTO", "UPDATE", "TABLE"]);
    for (let i = 0; i < stmtTokens.length; i++) {
      const t = stmtTokens[i];
      if (t.type !== "keyword") continue;
      const up = t.text.toUpperCase();
      if (!RELATION_KEYWORDS.has(up)) continue;
      // Find next identifier (skip whitespace/punctuation like commas in multi-table FROM)
      let j = i + 1;
      // For each comma-separated table reference until next clause keyword
      while (j < stmtTokens.length) {
        // skip optional ONLY / LATERAL
        while (j < stmtTokens.length && (stmtTokens[j].type === "keyword" && ["ONLY", "LATERAL"].includes(stmtTokens[j].text.toUpperCase()))) j++;
        const qn = readQualifiedName(stmtTokens, j);
        if (!qn?.name) break;
        j = qn.next;
        // Optional alias: AS name | name
        let alias = null;
        let aliasQuoted = false;
        // skip optional AS
        if (stmtTokens[j]?.type === "keyword" && stmtTokens[j].text.toUpperCase() === "AS") {
          j++;
          if (stmtTokens[j]?.type === "identifier" || stmtTokens[j]?.type === "quoted-identifier") {
            alias = stmtTokens[j].value ?? stmtTokens[j].text;
            aliasQuoted = stmtTokens[j].type === "quoted-identifier";
            j++;
          }
        } else if (stmtTokens[j]?.type === "identifier" || stmtTokens[j]?.type === "quoted-identifier") {
          // implicit alias (no AS) — but not if it's a keyword-like
          const nt = stmtTokens[j];
          if (!KEYWORDS.has(nt.text.toUpperCase())) {
            alias = nt.value ?? nt.text;
            aliasQuoted = nt.type === "quoted-identifier";
            j++;
          }
        }
        const schemaName = qn.schema || "public";
        const relKey = `${foldKey(schemaName, qn.schemaQuoted || false)}.${foldKey(qn.name, qn.nameQuoted)}`;
        const ref = {
          key: relKey,
          schema: schemaName,
          name: qn.name,
          alias: alias ?? qn.name,
          columns: lookupColumns(graph, relKey),
        };
        if (!visible.some(r => r.key === ref.key && r.alias === ref.alias)) {
          visible.push(ref);
        }
        if (alias) byAlias.set(foldKey(alias, aliasQuoted), ref);
        byName.set(foldKey(qn.name, qn.nameQuoted), ref);
        // Continue past , to next table reference
        if (stmtTokens[j]?.text === ",") { j++; continue; }
        break;
      }
    }

    // Find the "active" relation: the one whose alias/name matches the most recent identifier before a "."
    // Determined later in classifyCursor via prefix.
    return { visible, byAlias, byName, activeAlias: null, activeSchema: null, expectedTypes, jsonb: null };
  }

  function lookupColumns(graph, relKey) {
    if (!graph?._index?.relationByName) return undefined;
    const rel = graph._index.relationByName[relKey];
    if (!rel) return undefined;
    return rel.columns.map(c => ({
      name: c.name, key: c.key, dataType: c.dataType, baseType: c.baseType,
      isPrimaryKey: c.isPrimaryKey, isForeignKey: !!c.foreignKey, jsonb: c.baseType === "jsonb",
    }));
  }

  // Classify the cursor position to determine the completion slot.
  function classifyCursor(stmt, cursor, sql, rm, graph) {
    const { tokens, start } = stmt;
    // Build a string-relative cursor offset
    const relCursor = cursor - start;
    // Find the token just before the cursor (in source offsets)
    // We work with original `sql` string around cursor to get prefix.
    // Identify the prefix being typed: read backwards from cursor until whitespace or punctuation boundary.
    let prefixStart = cursor;
    while (prefixStart > 0) {
      const ch = sql[prefixStart - 1];
      if (/[A-Za-z0-9_]/.test(ch)) prefixStart--;
      else break;
    }
    const prefix = sql.slice(prefixStart, cursor);

    // Now identify the slot by scanning tokens before the cursor.
    // Find the token immediately preceding the cursor (its end <= cursor).
    let prevIdx = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].end <= cursor) prevIdx = i;
      else break;
    }
    const prev = tokens[prevIdx];

    // Check for qualified-column: alias. or schema.relation.
    if (prev?.type === "punctuation" && prev.text === ".") {
      // The identifier before the dot
      const identTok = tokens[prevIdx - 1];
      if (identTok) {
        const identName = identTok.value ?? identTok.text;
        const identQuoted = identTok.type === "quoted-identifier";
        const key = foldKey(identName, identQuoted);
        // Is it a schema?
        if (graph?._index?.schemas?.[key]) {
          return { kind: "schema-relation", from: prefixStart, to: cursor, prefix, activeSchema: identName };
        }
        // Is it an alias?
        const ref = rm.byAlias.get(key);
        if (ref) {
          return { kind: "qualified-column", from: prefixStart, to: cursor, prefix, activeRelation: ref, activeAlias: identName };
        }
        // Is it a relation name?
        const relRef = rm.byName.get(key);
        if (relRef) {
          return { kind: "qualified-column", from: prefixStart, to: cursor, prefix, activeRelation: relRef, activeAlias: identName };
        }
        // Unknown qualifier — treat as qualified-column anyway
        return { kind: "qualified-column", from: prefixStart, to: cursor, prefix };
      }
    }

    // JSONB path operators
    if (prev?.type === "operator" && (prev.text === "->" || prev.text === "->>" || prev.text === "#>" || prev.text === "#>>")) {
      // Find the column this applies to: walk back to find col -> ... chain
      let k = prevIdx - 1;
      while (k >= 0 && tokens[k]?.type === "operator" && (tokens[k].text === "->" || tokens[k].text === "->>" || tokens[k].text === "#>" || tokens[k].text === "#>>")) k--;
      // tokens[k] is the column identifier (possibly qualified)
      const colTok = tokens[k];
      const beforeTok = tokens[k - 1];
      let relationRef = null;
      let colName = null;
      if (beforeTok?.type === "punctuation" && beforeTok.text === ".") {
        const aliasTok = tokens[k - 2];
        const aliasKey = foldKey(aliasTok.value ?? aliasTok.text, aliasTok.type === "quoted-identifier");
        relationRef = rm.byAlias.get(aliasKey) ?? rm.byName.get(aliasKey);
        colName = colTok.value ?? colTok.text;
      } else if (colTok) {
        // Find which visible relation has this column
        colName = colTok.value ?? colTok.text;
        for (const ref of rm.visible) {
          if (ref.columns?.some(c => c.key === foldKey(colName, colTok.type === "quoted-identifier"))) {
            relationRef = ref; break;
          }
        }
      }
      if (relationRef && colName) {
        return {
          kind: "jsonb-path", from: prefixStart, to: cursor, prefix,
          jsonb: { relation: relationRef, column: colName, operator: prev.text },
        };
      }
    }

    // Look back for a clause keyword that determines the slot
    const clauseKwIdx = findLastClauseKeyword(tokens, prevIdx);
    const clauseKw = clauseKwIdx >= 0 ? tokens[clauseKwIdx].text.toUpperCase() : null;

    if (clauseKw === "FROM" || clauseKw === "JOIN" || clauseKw === "INTO" || clauseKw === "UPDATE" || clauseKw === "TABLE") {
      // But if there's a "." we already handled above. Check for "INSERT INTO table ("
      // Detect INSERT INTO table (
      if (clauseKw === "INTO") {
        // find if "(" was opened after the table name and not yet closed
        const tokIdx = findLastOpenParen(tokens, prevIdx);
        if (tokIdx >= 0) {
          // Check the keyword before "(" — should be a relation name; the slot is insert-column
          return { kind: "insert-column", from: prefixStart, to: cursor, prefix };
        }
      }
      return { kind: "relation", from: prefixStart, to: cursor, prefix };
    }
    if (clauseKw === "VALUES") {
      // VALUES ( ... ) — insert-value slot
      const tokIdx = findLastOpenParen(tokens, prevIdx);
      if (tokIdx >= 0) return { kind: "insert-value", from: prefixStart, to: cursor, prefix };
    }
    if (clauseKw === "SELECT" || clauseKw === "WHERE" || clauseKw === "ON" || clauseKw === "BY" || clauseKw === "HAVING" || clauseKw === "AND" || clauseKw === "OR") {
      // "BY" covers GROUP BY / ORDER BY
      return { kind: "column", from: prefixStart, to: cursor, prefix };
    }
    if (clauseKw === "WITH") {
      return { kind: "cte-name", from: prefixStart, to: cursor, prefix };
    }
    if (clauseKw === "VALUES") {
      return { kind: "insert-value", from: prefixStart, to: cursor, prefix };
    }
    // Default: column slot if we have visible relations, else keyword
    if (rm.visible.length) return { kind: "column", from: prefixStart, to: cursor, prefix };
    return { kind: "keyword", from: prefixStart, to: cursor, prefix };
  }

  function findLastClauseKeyword(tokens, upto) {
    const clauses = new Set(["FROM","JOIN","INTO","UPDATE","SELECT","WHERE","ON","HAVING","BY","VALUES","WITH","TABLE","AND","OR","INNER","LEFT","RIGHT","OUTER","FULL","CROSS","LATERAL"]);
    for (let i = upto; i >= 0; i--) {
      const t = tokens[i];
      if (t.type === "keyword" && clauses.has(t.text.toUpperCase())) {
        // "BY" must be preceded by GROUP/ORDER
        if (t.text.toUpperCase() === "BY") {
          // check previous keyword
          for (let j = i - 1; j >= 0; j--) {
            if (tokens[j].type === "keyword") {
              const up = tokens[j].text.toUpperCase();
              if (up === "GROUP" || up === "ORDER") return i;
              break;
            } else if (tokens[j].type === "identifier" || tokens[j].type === "punctuation") continue;
            else break;
          }
          continue;
        }
        return i;
      }
      // Stop at "(" or ";" — different scope
      if (t.type === "punctuation" && (t.text === "(" || t.text === ";")) return -1;
    }
    return -1;
  }

  function findLastOpenParen(tokens, upto) {
    let depth = 0;
    for (let i = upto; i >= 0; i--) {
      const t = tokens[i];
      if (t.type === "punctuation" && t.text === ")") depth++;
      else if (t.type === "punctuation" && t.text === "(") {
        if (depth === 0) return i;
        depth--;
      }
    }
    return -1;
  }

  // Build a CompletionContext at cursor.
  function buildCompletionContext(sql, cursor, graph) {
    if (cursor < 0 || cursor > sql.length) return { kind: "unknown", from: 0, to: 0, prefix: "", visibleRelations: [] };
    const tokens = tokenize(sql);
    const sig = significantTokens(tokens);
    const stmt = findStatementAtCursor(sig, cursor);
    if (!stmt) return { kind: "unknown", from: 0, to: 0, prefix: "", visibleRelations: [] };
    const rm = buildRelationMap(stmt.tokens, graph);
    const r = classifyCursor(stmt, cursor, sql, rm, graph);
    return {
      kind: r.kind,
      from: r.from,
      to: r.to,
      prefix: r.prefix,
      activeAlias: r.activeAlias,
      activeRelation: r.activeRelation,
      activeSchema: r.activeSchema,
      visibleRelations: rm.visible,
      jsonb: r.jsonb,
    };
  }

  // --- Candidate generation ---
  const BUILTIN_FUNCTIONS = [
    { name: "now", returnType: "timestamp" },
    { name: "current_timestamp", returnType: "timestamp" },
    { name: "current_date", returnType: "date" },
    { name: "current_time", returnType: "time" },
    { name: "user", returnType: "text" },
    { name: "current_user", returnType: "text" },
    { name: "session_user", returnType: "text" },
    { name: "count", returnType: "bigint" },
    { name: "sum", returnType: "numeric" },
    { name: "avg", returnType: "numeric" },
    { name: "min", returnType: "any" },
    { name: "max", returnType: "any" },
    { name: "coalesce", returnType: "any" },
    { name: "nullif", returnType: "any" },
    { name: "length", returnType: "integer" },
    { name: "lower", returnType: "text" },
    { name: "upper", returnType: "text" },
    { name: "substring", returnType: "text" },
    { name: "trim", returnType: "text" },
    { name: "to_char", returnType: "text" },
    { name: "to_date", returnType: "date" },
    { name: "to_timestamp", returnType: "timestamp" },
    { name: "extract", returnType: "numeric" },
    { name: "date_part", returnType: "numeric" },
    { name: "date_trunc", returnType: "timestamp" },
    { name: "age", returnType: "interval" },
    { name: "json_build_object", returnType: "json" },
    { name: "jsonb_build_object", returnType: "jsonb" },
    { name: "json_agg", returnType: "json" },
    { name: "jsonb_agg", returnType: "jsonb" },
    { name: "string_agg", returnType: "text" },
    { name: "array_agg", returnType: "array" },
    { name: "generate_series", returnType: "setof" },
    { name: "regexp_match", returnType: "text[]" },
    { name: "regexp_matches", returnType: "setof text[]" },
    { name: "regexp_replace", returnType: "text" },
    { name: "split_part", returnType: "text" },
    { name: "md5", returnType: "text" },
    { name: "encode", returnType: "text" },
    { name: "decode", returnType: "bytea" },
    { name: "uuid_generate_v4", returnType: "uuid" },
    { name: "gen_random_uuid", returnType: "uuid" },
  ];

  const COMMON_KEYWORDS = [
    "SELECT","FROM","WHERE","JOIN","LEFT JOIN","RIGHT JOIN","INNER JOIN","FULL JOIN","CROSS JOIN","ON","AS",
    "GROUP BY","ORDER BY","HAVING","LIMIT","OFFSET","UNION","INTERSECT","EXCEPT",
    "INSERT INTO","VALUES","UPDATE","SET","DELETE FROM","RETURNING",
    "WITH","RECURSIVE","CREATE TABLE","DROP TABLE","ALTER TABLE","ADD COLUMN","DROP COLUMN",
    "AND","OR","NOT","IN","NOT IN","EXISTS","BETWEEN","LIKE","ILIKE","IS NULL","IS NOT NULL","DISTINCT",
    "ASC","DESC","NULLS FIRST","NULLS LAST","CASE WHEN","THEN","ELSE","END",
    "COUNT(*)","COUNT(DISTINCT","SUM(","AVG(","MAX(","MIN(",
    "BEGIN","COMMIT","ROLLBACK",
    "EXPLAIN","ANALYZE","VACUUM","REINDEX",
  ];

  function generateCandidates(ctx, graph, usageMap) {
    const out = [];
    const lower = ctx.prefix.toLowerCase();
    const matchPrefix = (text) => !lower || text.toLowerCase().includes(lower);

    switch (ctx.kind) {
      case "relation": {
        if (graph?._index) {
          for (const relKey of Object.keys(graph._index.relationByName)) {
            const rel = graph._index.relationByName[relKey];
            if (!CONFIG.showSystemTables && (rel.schema === "pg_catalog" || rel.schema === "information_schema")) continue;
            const label = rel.schema === "public" ? rel.name : `${rel.schema}.${rel.name}`;
            if (!matchPrefix(label) && !matchPrefix(rel.name)) continue;
            out.push({
              kind: rel.kind === "view" ? "view" : (rel.kind === "materialized-view" ? "view" : "table"),
              label, detail: rel.kind, insertText: rel.schema === "public" ? rel.name : label,
              filterText: label, score: 0, source: "schema",
              symbolKey: `rel:${relKey}`,
            });
          }
        }
        // CTEs
        for (const ref of ctx.visibleRelations) {
          if (ref.cteName && matchPrefix(ref.cteName)) {
            out.push({ kind: "cte", label: ref.cteName, detail: "CTE", insertText: ref.cteName, filterText: ref.cteName, score: 0, source: "schema", symbolKey: `cte:${ref.cteName.toLowerCase()}` });
          }
        }
        break;
      }
      case "schema-relation": {
        if (graph?._index && ctx.activeSchema) {
          const schemaKey = foldKey(ctx.activeSchema, false);
          const schema = graph._index.schemas[schemaKey];
          if (schema) {
            for (const relKey of Object.keys(schema.relations)) {
              const rel = schema.relations[relKey];
              if (!matchPrefix(rel.name)) continue;
              out.push({ kind: "table", label: rel.name, detail: rel.kind, insertText: rel.name, filterText: rel.name, score: 0, source: "schema", symbolKey: `rel:${relKey}` });
            }
          }
        }
        break;
      }
      case "column":
      case "qualified-column": {
        const rels = ctx.activeRelation ? [ctx.activeRelation] : ctx.visibleRelations;
        const seen = new Set();
        for (const ref of rels) {
          if (!ref.columns) continue;
          for (const col of ref.columns) {
            if (!matchPrefix(col.name)) continue;
            if (seen.has(col.key)) continue;
            seen.add(col.key);
            out.push({
              kind: "column", label: col.name, detail: col.dataType,
              insertText: col.name, filterText: col.name, score: 0, source: "schema",
              symbolKey: `col:${ref.key}.${col.key}`,
              documentation: buildColumnDoc(col, ref),
            });
          }
        }
        // Also suggest functions
        for (const fn of BUILTIN_FUNCTIONS) {
          if (matchPrefix(fn.name)) {
            out.push({ kind: "function", label: fn.name + "()", detail: fn.returnType, insertText: fn.name + "()", filterText: fn.name, score: 0, source: "builtin", symbolKey: `fn:${fn.name}` });
          }
        }
        // Also schema functions
        if (graph?.functions) {
          for (const fn of graph.functions) {
            if (!matchPrefix(fn.name)) continue;
            out.push({ kind: "function", label: fn.name + "()", detail: fn.returnType, insertText: fn.name + "()", filterText: fn.name, score: 0, source: "schema", symbolKey: `fn:${fn.key}` });
          }
        }
        break;
      }
      case "jsonb-path": {
        if (ctx.jsonb && graph?._index) {
          const { relation, column } = ctx.jsonb;
          const rel = graph._index.relationByName[relation.key];
          const col = rel?.columns.find(c => c.key === foldKey(column, false));
          if (col?.jsonbPaths) {
            // Suggest top-level segments + children of already-typed path
            for (const path of col.jsonbPaths) {
              const seg = path.segments[0];
              if (seg && matchPrefix(seg)) {
                out.push({ kind: "jsonb-path", label: seg, detail: path.valueType, insertText: seg, filterText: seg, score: 0, source: "schema", symbolKey: `jsonb:${relation.key}.${col.key}.${seg}` });
              }
            }
          }
        }
        break;
      }
      case "insert-column": {
        // Find the target table from INSERT INTO <table> (
        // Reuse visibleRelations[0] as the target
        if (ctx.visibleRelations.length) {
          const ref = ctx.visibleRelations[0];
          if (ref.columns) {
            for (const col of ref.columns) {
              if (!matchPrefix(col.name)) continue;
              out.push({ kind: "column", label: col.name, detail: col.dataType, insertText: col.name, filterText: col.name, score: 0, source: "schema", symbolKey: `col:${ref.key}.${col.key}` });
            }
          }
        }
        break;
      }
      case "cte-name": {
        // Suggest a placeholder name
        break;
      }
      case "keyword":
      case "unknown":
      default: {
        for (const kw of COMMON_KEYWORDS) {
          if (matchPrefix(kw)) {
            out.push({ kind: "keyword", label: kw, detail: "", insertText: kw, filterText: kw, score: 0, source: "builtin", symbolKey: `kw:${kw}` });
          }
        }
        for (const fn of BUILTIN_FUNCTIONS) {
          if (matchPrefix(fn.name)) {
            out.push({ kind: "function", label: fn.name + "()", detail: fn.returnType, insertText: fn.name + "()", filterText: fn.name, score: 0, source: "builtin", symbolKey: `fn:${fn.name}` });
          }
        }
        break;
      }
    }

    return rankCandidates(out, ctx, usageMap);
  }

  function buildColumnDoc(col, ref) {
    const parts = [];
    parts.push(`**${ref.alias ?? ref.name}.${col.name}**`);
    if (col.dataType) parts.push(`Type: \`${col.dataType}\``);
    if (col.isPrimaryKey) parts.push("Primary key");
    if (col.isForeignKey) parts.push("Foreign key");
    return parts.join("\n");
  }

  function rankCandidates(items, ctx, usageMap) {
    const now = Date.now();
    const DAY = 86400000;
    for (const it of items) {
      const usage = usageMap?.get(it.symbolKey);
      const frequency = usage?.frequency ?? 0;
      const lastUsedAt = usage?.lastUsedAt ?? 0;
      const recency = lastUsedAt > 0 ? Math.max(0, 1 - (now - lastUsedAt) / (30 * DAY)) : 0;
      const prefixMatch = it.filterText.toLowerCase().startsWith(ctx.prefix.toLowerCase()) ? 1 : 0.5;
      const isKeyword = it.kind === "keyword" ? 1 : 0;
      const detailBonus = it.detail ? 0.1 : 0;
      const coldStart = frequency === 0 && lastUsedAt === 0;
      let score;
      if (coldStart) {
        // M (prefix match) + K (keyword) + D (detail)
        score = 0.5 * prefixMatch + 0.3 * isKeyword + 0.2 * detailBonus;
      } else {
        // S = 0.40M + 0.20R + 0.15F + 0.10L + 0.10K + 0.05D
        score = 0.40 * prefixMatch + 0.20 * recency + 0.15 * Math.log10(frequency + 1) / 2 + 0.10 * 0.5 + 0.10 * isKeyword + 0.05 * detailBonus;
      }
      // Stable tiebreaker: alphabetic
      it.score = score + (1 - it.label.toLowerCase().charCodeAt(0) / 256) * 0.001;
    }
    items.sort((a, b) => b.score - a.score || (a.label < b.label ? -1 : 1));
    return items.slice(0, CONFIG.maxCandidates);
  }

  // ┌─────────────────────────────────────────────────────────────────┐
  // │ Stage 4: Diagnostics & danger detection                         │
  // └─────────────────────────────────────────────────────────────────┘

  function runDiagnostics(sql, graph) {
    const diags = [];
    try {
      if (!sql || !sql.trim()) return diags;
      const tokens = tokenize(sql);
      const sig = significantTokens(tokens);
      const stmts = splitStatements(sig);
      // Red: whole-document paren balance + unterminated strings/identifiers
      checkParenBalance(tokens, diags);
      checkUnclosedStrings(tokens, diags);
      // Per-statement: clause order, alias.column existence, INSERT arity, type mismatch
      for (const stmt of stmts) {
        if (!stmt.length) continue;
        checkStatementDiagnostics(stmt, diags, graph);
      }
    } catch (e) {
      // tolerant: log and continue
      warn("diagnostics error:", e?.message || e);
    }
    return dedupeDiagnostics(diags);
  }

  // Red: balanced parentheses across the whole document.
  function checkParenBalance(tokens, diags) {
    let depth = 0;
    for (const t of tokens) {
      if (t.type === "eof") break;
      if (t.type === "punctuation" && t.text === "(") depth++;
      else if (t.type === "punctuation" && t.text === ")") {
        depth--;
        if (depth < 0) {
          diags.push({ severity: "error", from: t.start, to: t.end, message: "Unexpected closing parenthesis" });
          depth = 0;
        }
      }
    }
    if (depth > 0) {
      // find last unclosed (
      let lastOpen = null;
      let d = 0;
      for (const t of tokens) {
        if (t.type === "eof") break;
        if (t.type === "punctuation" && t.text === "(") { d++; lastOpen = t; }
        else if (t.type === "punctuation" && t.text === ")") d--;
      }
      const from = lastOpen ? lastOpen.start : 0;
      diags.push({ severity: "error", from, to: from + 1, message: `Unclosed parenthesis (${depth} open)` });
    }
  }

  // Red: unterminated string literals / quoted identifiers.
  function checkUnclosedStrings(tokens, diags) {
    for (const t of tokens) {
      if (t.type === "eof") break;
      if (t.type === "string" && !t.text.endsWith("'")) {
        diags.push({ severity: "error", from: t.start, to: t.end, message: "Unterminated string literal" });
      }
      if (t.type === "quoted-identifier" && !t.text.endsWith('"')) {
        diags.push({ severity: "error", from: t.start, to: t.end, message: "Unterminated quoted identifier" });
      }
    }
  }

  function checkStatementDiagnostics(stmt, diags, graph) {
    checkClauseOrder(stmt, diags);
    const head = stmt[0]?.text?.toUpperCase?.() ?? "";
    if (head === "INSERT") checkInsertArity(stmt, diags, graph);
    if (head === "SELECT" || head === "UPDATE" || head === "DELETE") checkComparisonTypes(stmt, diags, graph);
    checkAliasColumns(stmt, diags, graph);
  }

  // Red: clause ordering SELECT..FROM..WHERE..GROUP BY..HAVING..ORDER BY..LIMIT/OFFSET
  function checkClauseOrder(stmt, diags) {
    const clauseOrder = ["SELECT", "FROM", "WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "OFFSET"];
    let lastIdx = -1;
    for (let i = 0; i < stmt.length; i++) {
      const t = stmt[i];
      if (t.type !== "keyword") continue;
      const up = t.text.toUpperCase();
      const idx = clauseOrder.indexOf(up);
      if (idx < 0) continue;
      // GROUP / ORDER must be followed by BY
      if (up === "GROUP" || up === "ORDER") {
        const next = stmt[i + 1];
        if (next?.text.toUpperCase() !== "BY") continue;
      }
      if (idx < lastIdx) {
        diags.push({ severity: "error", from: t.start, to: t.end, message: `Clause "${up}" appears out of order` });
      } else {
        lastIdx = idx;
      }
    }
  }

  // Yellow: alias.column where the column does not exist on the relation,
  // or the qualifier itself is unknown (not a schema/alias/relation in scope).
  function checkAliasColumns(stmt, diags, graph) {
    const rm = buildRelationMap(stmt, graph);
    for (let i = 0; i < stmt.length; i++) {
      const t = stmt[i];
      if (t.type !== "punctuation" || t.text !== ".") continue;
      const aliasTok = stmt[i - 1];
      const colTok = stmt[i + 1];
      if (!aliasTok || !colTok) continue;
      if (aliasTok.type !== "identifier" && aliasTok.type !== "quoted-identifier") continue;
      if (colTok.type !== "identifier" && colTok.type !== "quoted-identifier") continue;
      const aliasKey = foldKey(aliasTok.value ?? aliasTok.text, aliasTok.type === "quoted-identifier");
      if (graph?._index?.schemas?.[aliasKey]) continue; // schema qualifier — ok
      const ref = rm.byAlias.get(aliasKey) ?? rm.byName.get(aliasKey);
      if (!ref) {
        diags.push({
          severity: "warning", from: aliasTok.start, to: colTok.end,
          message: `Unknown qualifier "${aliasTok.value ?? aliasTok.text}"`,
        });
        continue;
      }
      if (!ref.columns?.length) continue; // CTE / unknown projection — cannot verify
      const colKey = foldKey(colTok.value ?? colTok.text, colTok.type === "quoted-identifier");
      if (!ref.columns.some(c => c.key === colKey)) {
        diags.push({
          severity: "warning", from: aliasTok.start, to: colTok.end,
          message: `Column "${aliasTok.text}.${colTok.text}" does not exist on ${ref.schema ? ref.schema + "." : ""}${ref.name}`,
        });
      }
    }
  }

  // Yellow: INSERT column count vs VALUES arity mismatch + unknown columns.
  function checkInsertArity(stmt, diags, graph) {
    if (!graph?._index) return;
    const upAt = i => (i >= 0 && i < stmt.length ? stmt[i].text.toUpperCase() : "");
    if (upAt(0) !== "INSERT" || upAt(1) !== "INTO") return;
    let i = 2;
    let schemaName = "public";
    let tableName = null;
    const t0 = stmt[i];
    if (!t0) return;
    if (stmt[i + 1]?.text === "." && stmt[i + 2]) {
      schemaName = t0.value ?? t0.text;
      tableName = stmt[i + 2].value ?? stmt[i + 2].text;
      i += 3;
    } else {
      tableName = t0.value ?? t0.text;
      i += 1;
    }
    // optional column list
    let cols = [];
    if (stmt[i]?.text === "(") {
      const closeIdx = findMatchingParenIdx(stmt, i);
      if (closeIdx < 0) return;
      cols = splitTopLevelCommasTokens(stmt.slice(i + 1, closeIdx))
        .map(p => p.map(t => t.text).join("").trim())
        .filter(Boolean);
      i = closeIdx + 1;
    }
    if (!cols.length) return;
    // find VALUES ( ... )
    while (i < stmt.length && upAt(i) !== "VALUES") i++;
    if (upAt(i) !== "VALUES") return;
    i++;
    if (stmt[i]?.text !== "(") return;
    const closeIdx = findMatchingParenIdx(stmt, i);
    if (closeIdx < 0) return;
    const valuesCount = splitTopLevelCommasTokens(stmt.slice(i + 1, closeIdx)).filter(p => p.length > 0).length;
    if (cols.length !== valuesCount) {
      diags.push({
        severity: "warning", from: stmt[i].start, to: stmt[closeIdx].end,
        message: `Column count (${cols.length}) does not match VALUES count (${valuesCount})`,
      });
    }
    // unknown columns on target table
    const relKey = `${foldKey(schemaName, false)}.${foldKey(tableName, false)}`;
    const rel = graph._index.relationByName[relKey];
    if (!rel) return;
    for (const c of cols) {
      const colKey = foldKey(c.replace(/^["']|["']$/g, ""), false);
      if (!rel.columns.some(col => col.key === colKey)) {
        diags.push({
          severity: "warning", from: stmt[0].start, to: stmt[0].end,
          message: `Column "${c}" does not exist on ${schemaName}.${tableName}`,
        });
      }
    }
  }

  // Yellow: obvious numeric-vs-text comparison mismatch (conservative).
  function checkComparisonTypes(stmt, diags, graph) {
    if (!graph?._index) return;
    const OPS = new Set(["=", "!=", "<>", "<", ">", "<=", ">="]);
    const rm = buildRelationMap(stmt, graph);
    for (let i = 0; i < stmt.length; i++) {
      const t = stmt[i];
      if (t.type !== "operator" || !OPS.has(t.text)) continue;
      const left = stmt[i - 1];
      const right = stmt[i + 1];
      if (!left || !right) continue;
      const lt = inferTokenType(left, rm, graph);
      const rt = inferTokenType(right, rm, graph);
      if (lt && rt && diagIsNumeric(lt) !== diagIsNumeric(rt)) {
        diags.push({
          severity: "warning", from: left.start, to: right.end,
          message: `Possible type mismatch: ${lt} vs ${rt}`,
        });
      }
    }
  }

  function inferTokenType(tok, rm, graph) {
    if (tok.type === "string") return "text";
    if (tok.type === "number") return "numeric";
    if (tok.type === "identifier" || tok.type === "quoted-identifier") {
      const name = foldKey(tok.value ?? tok.text, tok.type === "quoted-identifier");
      if (rm.byAlias.has(name) || rm.byName.has(name)) return null; // relation reference, not value
      for (const ref of rm.visible) {
        const col = ref.columns?.find(c => c.key === name);
        if (col) return col.baseType;
      }
      for (const relKey of Object.keys(graph._index.relationByName)) {
        const col = graph._index.relationByName[relKey].columns.find(c => c.key === name);
        if (col) return col.baseType;
      }
    }
    return null;
  }

  function diagIsNumeric(t) {
    return ["integer", "bigint", "smallint", "numeric", "real", "double precision", "money"]
      .includes(String(t).toLowerCase());
  }

  function findMatchingParenIdx(tokens, openIdx) {
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

  function splitTopLevelCommasTokens(tokens) {
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

  // Keep the most severe diagnostic for overlapping ranges.
  function dedupeDiagnostics(diags) {
    const sorted = [...diags].sort((a, b) => a.from - b.from || a.to - b.to);
    const out = [];
    for (const d of sorted) {
      const prev = out[out.length - 1];
      if (prev && d.from < prev.to) {
        if (d.severity === "error" && prev.severity !== "error") out[out.length - 1] = d;
        continue;
      }
      out.push(d);
    }
    return out;
  }

  // Danger detection
  // Patterns anchor at statement head (^) — matching is done per statement after
  // comment stripping, so DDL mentioned inside strings/comments never triggers.
  const DANGER_PATTERNS = [
    { re: /^\s*TRUNCATE\b/i, kind: "truncate", severity: "high" },
    { re: /^\s*DROP\s+(TABLE|SCHEMA|DATABASE)\b/i, kind: "drop", severity: "high" },
    { re: /^\s*ALTER\s+TABLE\b[^;]*\bDROP\s+COLUMN\b/i, kind: "alter-drop-column", severity: "medium" },
    { re: /^\s*DELETE\s+FROM\b/i, kind: "delete", severity: "medium" },
    { re: /^\s*UPDATE\b[^;]*\bSET\b/i, kind: "update", severity: "medium" },
  ];

  // Strip `-- line` and `/* block */` comments so commented-out DDL
  // (e.g. `-- DROP TABLE x`) does not trigger false danger matches.
  function stripSqlComments(sql) {
    return sql
      .replace(/--[^\n]*/g, " ")
      .replace(/\/\*[\s\S]*?\*\//g, " ");
  }

  function quickDetectDangerSync(sql) {
    if (!CONFIG.dangerInterceptEnabled) return null;
    const noComment = stripSqlComments(sql || "");
    const trimmed = noComment.trim();
    if (!trimmed) return null;
    // Evaluate each statement independently (split on `;`)
    const statements = trimmed.split(";").map(s => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      const danger = detectDangerInStatement(stmt);
      if (danger) return danger;
    }
    return null;
  }

  function detectDangerInStatement(stmt) {
    for (const pat of DANGER_PATTERNS) {
      const m = pat.re.exec(stmt);
      if (!m) continue;
      // Extract target object name if possible
      const target = extractDangerTarget(stmt, pat.kind);
      // Check if DELETE/UPDATE has WHERE
      if (pat.kind === "delete" || pat.kind === "update") {
        const afterMatch = stmt.slice(m.index + m[0].length);
        const whereIdx = afterMatch.search(/\bWHERE\b/i);
        if (whereIdx >= 0) {
          // Check if WHERE is trivially true
          const whereClause = afterMatch.slice(whereIdx + 6);
          if (isTriviallyTrueWhere(whereClause)) {
            return { kind: pat.kind, severity: "high", target, reason: "WHERE clause is trivially true" };
          }
          // Has WHERE — not a danger
          continue;
        }
        return { kind: pat.kind, severity: pat.severity, target, reason: `${pat.kind.toUpperCase()} without WHERE clause` };
      }
      return { kind: pat.kind, severity: pat.severity, target, reason: `${pat.kind} statement` };
    }
    return null;
  }

  function extractDangerTarget(sql, kind) {
    const m = /\b(?:FROM|TABLE|SCHEMA|DATABASE|INTO|UPDATE)\s+([A-Za-z_][A-Za-z0-9_.]*)/i.exec(sql);
    return m?.[1] ?? "<unknown>";
  }

  function isTriviallyTrueWhere(clause) {
    const c = clause.trim().toLowerCase();
    if (/^\s*1\s*=\s*1\s*($|[;\s])/i.test(c)) return true;
    if (/^\s*true\s*($|[;\s])/i.test(c)) return true;
    if (/^\s*'([^']*)'\s*=\s*'\1'\s*($|[;\s])/i.test(c)) return true;
    return false;
  }

  function canExplainStatement(sql) {
    const trimmed = sql.trim().toUpperCase();
    return /^\s*(DELETE|UPDATE)\b/i.test(trimmed);
  }

  // ┌─────────────────────────────────────────────────────────────────┐
  // │ Stage 5: Blob URL Worker + main-thread fallback                 │
  // └─────────────────────────────────────────────────────────────────┘
  //
  // Heavy computations (DDL parsing, completion candidate building,
  // diagnostics) run inside a Blob URL Worker assembled at runtime from
  // `Function.prototype.toString()` of the pure algorithm functions plus
  // serialized constants. If pgAdmin CSP blocks Blob Workers
  // (SecurityError) or the worker fails to post its ready message within
  // `CONFIG.workerPingTimeoutMs`, every call transparently falls back to
  // main-thread synchronous execution with the identical call signature.

  function buildWorkerSource() {
    const fnNames = [
      // tokenizer
      "tokenize", "significantTokens", "splitStatements",
      // ddl parser
      "foldKey", "parseDdl", "parseStatement", "readQualifiedName", "parseCreate",
      "parseCreateSchema", "parseCreateTable", "parseColumnDef", "parseTableConstraint",
      "parseCreateView", "parseCreateForeignTable", "parseCreateFunction", "parseCreateIndex",
      "parseAlter", "parseComment", "normalizeBaseType",
      "parseJsonbAnnotations", "buildIndex",
      // context parser
      "findStatementAtCursor", "buildRelationMap", "lookupColumns", "classifyCursor",
      "findLastClauseKeyword", "findLastOpenParen", "buildCompletionContext",
      // completion engine
      "generateCandidates", "buildColumnDoc", "rankCandidates",
      // diagnostics
      "runDiagnostics", "checkParenBalance", "checkUnclosedStrings",
      "checkStatementDiagnostics", "checkClauseOrder", "checkAliasColumns",
      "checkInsertArity", "checkComparisonTypes", "inferTokenType",
      "diagIsNumeric", "findMatchingParenIdx", "splitTopLevelCommasTokens",
      "dedupeDiagnostics",
    ];
    const consts = [
      `const CONFIG = ${JSON.stringify({ maxCandidates: CONFIG.maxCandidates, showSystemTables: CONFIG.showSystemTables })};`,
      `const PARSER_VERSION = ${JSON.stringify(PARSER_VERSION)};`,
      `const KEYWORDS = new Set(${JSON.stringify([...KEYWORDS])});`,
      `const BUILTIN_FUNCTIONS = ${JSON.stringify(BUILTIN_FUNCTIONS)};`,
      `const COMMON_KEYWORDS = ${JSON.stringify(COMMON_KEYWORDS)};`,
      `const KEYWORD_CHAR_RE = ${KEYWORD_CHAR_RE.toString()};`,
      `const IDENT_START_RE = ${IDENT_START_RE.toString()};`,
      `const DIGIT_RE = ${DIGIT_RE.toString()};`,
      `const WHITESPACE_RE = ${WHITESPACE_RE.toString()};`,
      `const PUNCTUATION = new Set(${JSON.stringify([...PUNCTUATION])});`,
      `const log = () => {}; const warn = () => {}; const error = () => {};`,
    ];
    const fnDecls = fnNames
      .map(name => {
        const fn = eval(name);
        return `const ${name} = ${fn.toString()};`;
      })
      .join("\n");
    const dispatcher = `
      const __handlers = {
        parseDdl: (a) => parseDdl(a.rawDdl, a.sourceFileName),
        buildIndex: (a) => buildIndex(a.graph),
        parseJsonb: (a) => { parseJsonbAnnotations(a.rawDdl, a.graph); return a.graph; },
        buildCompletionContext: (a) => buildCompletionContext(a.sql, a.cursor, a.graph),
        generateCandidates: (a) => generateCandidates(a.ctx, a.graph, a.usageMap),
        runDiagnostics: (a) => runDiagnostics(a.sql, a.graph),
      };
      self.postMessage({ type: "pg4:ready" });
      self.onmessage = (ev) => {
        const { id, method, args } = ev.data || {};
        const h = __handlers[method];
        if (!h) { self.postMessage({ id, ok: false, error: "unknown worker method: " + method }); return; }
        Promise.resolve().then(() => h(args)).then(
          (result) => self.postMessage({ id, ok: true, result }),
          (err) => self.postMessage({ id, ok: false, error: String((err && err.message) || err) })
        );
      };
    `;
    return `"use strict";\n${consts.join("\n")}\n${fnDecls}\n${dispatcher}`;
  }

  // Pending worker RPC calls: id -> { resolve, reject }
  const workerRpcPending = new Map();
  let workerRpcSeq = 0;

  function createComputeWorker() {
    return new Promise(resolve => {
      let url = null;
      let w = null;
      try {
        const src = buildWorkerSource();
        url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
        w = new Worker(url);
      } catch (e) {
        warn("worker blocked by CSP, falling back to main thread");
        resolve(null);
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { w.terminate(); } catch {}
        if (url) URL.revokeObjectURL(url);
        warn("worker: ready timeout, falling back to main thread");
        resolve(null);
      }, CONFIG.workerPingTimeoutMs);
      w.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { w.terminate(); } catch {}
        if (url) URL.revokeObjectURL(url);
        warn("worker: error, falling back to main thread");
        resolve(null);
      };
      w.onmessage = (ev) => {
        const d = ev.data;
        if (d?.type === "pg4:ready") {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (url) URL.revokeObjectURL(url);
          log("worker: compute worker active (Blob URL)");
          resolve(w);
          return;
        }
        // RPC response
        if (d && d.id != null && workerRpcPending.has(d.id)) {
          const p = workerRpcPending.get(d.id);
          workerRpcPending.delete(d.id);
          if (d.ok) p.resolve(d.result);
          else p.reject(new Error(d.error));
        }
      };
    });
  }

  // Main-thread fallback: identical call signature to the worker handlers.
  function localCompute(method, args) {
    switch (method) {
      case "parseDdl":
        return parseDdl(args.rawDdl, args.sourceFileName);
      case "buildIndex":
        return buildIndex(args.graph);
      case "parseJsonb": {
        parseJsonbAnnotations(args.rawDdl, args.graph);
        return args.graph;
      }
      case "buildCompletionContext":
        return buildCompletionContext(args.sql, args.cursor, args.graph);
      case "generateCandidates":
        return generateCandidates(args.ctx, args.graph, args.usageMap);
      case "runDiagnostics":
        return runDiagnostics(args.sql, args.graph);
      default:
        throw new Error(`unknown worker method: ${method}`);
    }
  }

  // Worker RPC facade. Uses the Blob Worker when available; any worker
  // failure (or unavailability) transparently falls back to main thread.
  async function callWorker(method, args) {
    const w = pg4.state.worker;
    if (w) {
      try {
        return await new Promise((resolve, reject) => {
          const id = ++workerRpcSeq;
          workerRpcPending.set(id, { resolve, reject });
          w.postMessage({ id, method, args });
        });
      } catch (e) {
        warn(`worker call "${method}" failed, falling back to main thread:`, e?.message || e);
      }
    }
    return localCompute(method, args);
  }

  // ┌─────────────────────────────────────────────────────────────────┐
  // │ Stage 6: CM6 editor discovery & adoption                       │
  // └─────────────────────────────────────────────────────────────────┘
  //
  // pgAdmin packs & minifies CM6, hiding `cmView` on the DOM and obscuring
  // the EditorView class. Two strategies, in order:
  //   1) el.cmView?.view  — CM6 attaches this when its DOM is created.
  //      Usually available even in minified bundles.
  //   2) Walk `window.webpackChunk*` for any class with a static
  //      `findFromDOM` method, then call `findFromDOM(el)`. CRITICAL: do
  //      NOT require a `create` static — this pgAdmin's EditorView lacks it.

  let cachedEditorViewClass = null;

  function findEditorViewClassFromWebpack() {
    if (cachedEditorViewClass) return cachedEditorViewClass;
    const chunks = [];
    // Collect all webpack chunk arrays on window
    for (const k of Object.keys(window)) {
      if (k.startsWith("webpackChunk") && Array.isArray(window[k])) {
        chunks.push(window[k]);
      }
    }
    if (!chunks.length && Array.isArray(window.webpackChunk)) chunks.push(window.webpackChunk);
    if (!chunks.length) return null;

    // mini-require: rebuild module graph from chunk push calls
    const moduleCache = {};
    const chunkModulesById = {};
    for (const chunkArr of chunks) {
      // Each entry is [chunkIds, modules, runtime?]
      for (const entry of chunkArr) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const modules = entry[1];
        if (typeof modules !== "object" || !modules) continue;
        for (const id of Object.keys(modules)) {
          chunkModulesById[id] = modules[id];
        }
      }
    }
    // Resolve a module by calling its factory with (module, exports, require)
    const requireById = (id) => {
      if (moduleCache[id]) return moduleCache[id].exports;
      const mod = { exports: {} };
      moduleCache[id] = mod;
      const factory = chunkModulesById[id];
      if (typeof factory !== "function") return mod.exports;
      try {
        // Mini require: only by numeric id, returns module.exports
        factory(mod, mod.exports, requireById);
      } catch (e) {
        // tolerate: factory may call require for missing modules
      }
      return mod.exports;
    };

    // Scan every resolved module's exports for a class with static findFromDOM
    for (const id of Object.keys(chunkModulesById)) {
      const exp = requireById(id);
      if (!exp || typeof exp !== "object") continue;
      // Could be the class itself, or a default export, or a property
      const candidates = [exp, exp.default, ...Object.values(exp)];
      for (const c of candidates) {
        if (typeof c === "function" && typeof c.findFromDOM === "function" && !c.__pg4Seen) {
          cachedEditorViewClass = c;
          return c;
        }
      }
    }
    return null;
  }

  function findViewOnElement(el) {
    // 1) Preferred: el.cmView?.view
    try {
      const cmView = el.cmView;
      if (cmView && cmView.view && typeof cmView.view.dispatch === "function") {
        return cmView.view;
      }
    } catch {}
    // 2) Fallback: EditorView.findFromDOM(el)
    try {
      const EditorViewClass = findEditorViewClassFromWebpack();
      if (EditorViewClass && typeof EditorViewClass.findFromDOM === "function") {
        const v = EditorViewClass.findFromDOM(el);
        if (v && typeof v.dispatch === "function") return v;
      }
    } catch (e) {
      warn("findFromDOM failed:", e?.message || e);
    }
    return null;
  }

  function tryAdoptEditor(el) {
    if (!el || !el.classList?.contains("cm-editor")) return null;
    if (el.__pg4EditorId) {
      // Already adopted — verify session still exists
      const sess = pg4.state.editors.get(el.__pg4EditorId);
      if (sess) return sess;
    }
    const view = findViewOnElement(el);
    if (!view) {
      // Editor not ready yet; will retry via MutationObserver
      return null;
    }
    // Verify the view has the methods we need
    if (typeof view.state?.doc !== "object" || typeof view.dispatch !== "function" || typeof view.coordsAtPos !== "function") {
      return null;
    }
    const editorId = `cm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const session = {
      editorId,
      el,
      view,
      completionMenu: null,
      hoverCard: null,
      diagLayer: null,
      lastCompletionAt: 0,
      lastDiagAt: 0,
      lastHoverAt: 0,
      updateListener: null,
    };
    el.__pg4EditorId = editorId;
    pg4.state.editors.set(editorId, session);
    log("editor adopted", editorId);
    // Wire input listener immediately (diagnostics + auto completion trigger)
    attachViewUpdateListener(session);
    session.__inputWired = true;
    return session;
  }

  function dispatchCompletion(view, from, to, insert) {
    if (!view) return;
    try {
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        userEvent: "input",
      });
    } catch (e) {
      warn("dispatch failed:", e?.message || e);
    }
  }

  function scanForEditors(root = document) {
    const els = root.querySelectorAll ? root.querySelectorAll(".cm-editor") : [];
    for (const el of els) tryAdoptEditor(el);
  }

  function startEditorMutationObserver() {
    if (pg4.state.mutationObserver) return;
    pg4.state.mutationObserver = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList?.contains("cm-editor")) {
            tryAdoptEditor(node);
          } else if (node.querySelectorAll) {
            const els = node.querySelectorAll(".cm-editor");
            for (const el of els) tryAdoptEditor(el);
          }
        }
        for (const node of mut.removedNodes) {
          if (node.nodeType !== 1) continue;
          const id = node.__pg4EditorId;
          if (id) cleanupEditorSession(id);
          else if (node.querySelectorAll) {
            const els = node.querySelectorAll("[data-pg4-editor-id]");
            for (const el of els) cleanupEditorSession(el.__pg4EditorId);
          }
        }
      }
    });
    pg4.state.mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function cleanupEditorSession(editorId) {
    const sess = pg4.state.editors.get(editorId);
    if (!sess) return;
    try { sess.completionMenu?.remove(); } catch {}
    try { sess.hoverCard?.remove(); } catch {}
    try { sess.diagLayer?.remove(); } catch {}
    if (sess.el) sess.el.__pg4EditorId = null;
    pg4.state.editors.delete(editorId);
    log("editor session cleaned:", editorId);
  }

  // ┌─────────────────────────────────────────────────────────────────┐
  // │ Stage 7: Overlay UI (Shadow DOM host + menu + hover + diag + danger) │
  // └─────────────────────────────────────────────────────────────────┘

  const OVERLAY_HOST_ID = "__pg4_overlay_root__";
  const THEME_DARK = "dark", THEME_LIGHT = "light";

  function ensureOverlayHost() {
    if (pg4.state.overlayRoot) return pg4.state.overlayRoot;
    let host = document.getElementById(OVERLAY_HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = OVERLAY_HOST_ID;
      host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
      document.documentElement.appendChild(host);
    }
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    pg4.state.overlayRoot = shadow;
    injectBaseStyles(shadow);
    detectTheme();
    // Watch pgAdmin theme changes (debounced)
    let themeTimer = null;
    const themeObs = new MutationObserver(() => {
      if (themeTimer) return;
      themeTimer = setTimeout(() => {
        themeTimer = null;
        detectTheme();
      }, 300);
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    themeObs.observe(document.body, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return shadow;
  }

  function injectBaseStyles(shadow) {
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .pg4-root {
        --pg4-bg: #ffffff;
        --pg4-bg-elevated: #ffffff;
        --pg4-fg: #1f2328;
        --pg4-fg-muted: #57606a;
        --pg4-border: #d0d7de;
        --pg4-accent: #0969da;
        --pg4-warn: #bf8700;
        --pg4-error: #cf222e;
        --pg4-shadow: 0 8px 24px rgba(0,0,0,.12);
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        color: var(--pg4-fg);
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 2147483647;
      }
      .pg4-root[data-theme="dark"] {
        --pg4-bg: #1e1e1e;
        --pg4-bg-elevated: #252526;
        --pg4-fg: #d4d4d4;
        --pg4-fg-muted: #9d9d9d;
        --pg4-border: #3c3c3c;
        --pg4-accent: #4daafc;
        --pg4-warn: #d29922;
        --pg4-error: #f48771;
        --pg4-shadow: 0 8px 24px rgba(0,0,0,.4);
      }
    `;
    shadow.appendChild(style);
    const root = document.createElement("div");
    root.className = "pg4-root";
    root.setAttribute("data-theme", "light");
    shadow.appendChild(root);
  }

  function detectTheme() {
    if (!pg4.state.overlayRoot) return;
    const root = pg4.state.overlayRoot.querySelector(".pg4-root");
    if (!root) return;
    let isDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    try {
      // pgAdmin typically uses .dark or body background brightness
      const sample = document.querySelector(".pg-admin-dark, .dark, [data-theme='dark']") || document.body;
      const bg = window.getComputedStyle(sample).backgroundColor;
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        const [r, g, b] = [+m[1], +m[2], +m[3]].map(Number);
        // relative luminance (sRGB)
        const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        isDark = lum < 0.4;
      }
    } catch {}
    root.setAttribute("data-theme", isDark ? THEME_DARK : THEME_LIGHT);
  }

  function attachOverlayElement(tag, props = {}, style = {}) {
    const shadow = ensureOverlayHost();
    const root = shadow.querySelector(".pg4-root");
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("data-") || k === "role" || k === "aria-") el.setAttribute(k, v);
      else el[k] = v;
    }
    if (style) {
      const css = Object.entries(style).map(([k, v]) => `${k.replace(/[A-Z]/g, m => "-" + m.toLowerCase())}:${v}`).join(";");
      el.style.cssText += css;
    }
    root.appendChild(el);
    return el;
  }

  // --- Completion menu ---
  const KIND_ICON = {
    table: "📋", view: "👁", schema: "🗂", column: "📌",
    function: "ƒ()", keyword: "K", snippet: "✂", "jsonb-path": "🟧", cte: "🔁",
  };

  function showCompletionMenu(session, items, from, to) {
    if (!items.length) { hideCompletionMenu(session); return; }
    const shadow = ensureOverlayHost();
    const root = shadow.querySelector(".pg4-root");
    if (!session.completionMenu) {
      const menu = document.createElement("div");
      menu.className = "pg4-menu";
      menu.setAttribute("role", "listbox");
      menu.style.cssText = `
        position: fixed; pointer-events: auto;
        background: var(--pg4-bg-elevated); color: var(--pg4-fg);
        border: 1px solid var(--pg4-border); border-radius: 6px;
        box-shadow: var(--pg4-shadow); max-height: 280px; overflow-y: auto;
        min-width: 240px; max-width: 480px; font-size: 13px; z-index: 2147483647;
      `;
      const styleInner = document.createElement("style");
      styleInner.textContent = `
        .pg4-menu-item { padding: 4px 10px; display: flex; gap: 8px; align-items: center; cursor: pointer; }
        .pg4-menu-item .pg4-icon { width: 16px; text-align: center; opacity: .8; font-family: monospace; }
        .pg4-menu-item .pg4-label { flex: 1; }
        .pg4-menu-item .pg4-detail { color: var(--pg4-fg-muted); font-size: 11px; font-family: monospace; }
        .pg4-menu-item.active, .pg4-menu-item:hover { background: var(--pg4-accent); color: #fff; }
        .pg4-menu-item.active .pg4-detail, .pg4-menu-item:hover .pg4-detail { color: #e0e0e0; }
      `;
      menu.appendChild(styleInner);
      root.appendChild(menu);
      session.completionMenu = menu;
      session.completionActiveIdx = 0;
      session.completionItems = [];
    }
    const menu = session.completionMenu;
    // Render items
    menu.querySelectorAll(".pg4-menu-item").forEach(n => n.remove());
    session.completionItems = items.slice(0, 50);
    session.completionActiveIdx = 0;
    const list = document.createElement("div");
    for (let i = 0; i < session.completionItems.length; i++) {
      const it = session.completionItems[i];
      const item = document.createElement("div");
      item.className = "pg4-menu-item" + (i === 0 ? " active" : "");
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", i === 0 ? "true" : "false");
      item.innerHTML = `<span class="pg4-icon">${escapeHtml(KIND_ICON[it.kind] ?? "·")}</span>` +
        `<span class="pg4-label">${escapeHtml(highlightPrefix(it.label, items.prefix || ""))}</span>` +
        (it.detail ? `<span class="pg4-detail">${escapeHtml(it.detail)}</span>` : "");
      item.dataset.idx = String(i);
      item.addEventListener("mouseenter", () => setCompletionActive(session, i));
      item.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        applyCompletion(session, i, from, to);
      });
      list.appendChild(item);
    }
    menu.appendChild(list);
    // Position
    positionCompletionMenu(session, from);
    menu.style.display = "block";
  }

  function highlightPrefix(label, prefix) {
    if (!prefix) return label;
    const lower = label.toLowerCase();
    const idx = lower.indexOf(prefix.toLowerCase());
    if (idx < 0) return label;
    return label.slice(0, idx) + "<b>" + escapeHtml(label.slice(idx, idx + prefix.length)) + "</b>" + escapeHtml(label.slice(idx + prefix.length));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function positionCompletionMenu(session, pos) {
    const menu = session.completionMenu;
    if (!menu) return;
    try {
      const coords = session.view.coordsAtPos(pos);
      const rect = menu.getBoundingClientRect();
      const margin = 4;
      let top = coords.bottom + margin;
      let left = coords.left;
      if (top + rect.height > window.innerHeight - 8) {
        // flip above cursor
        top = coords.top - rect.height - margin;
        if (top < 8) top = 8;
      }
      if (left + rect.width > window.innerWidth - 8) {
        left = window.innerWidth - rect.width - 8;
      }
      menu.style.top = top + "px";
      menu.style.left = left + "px";
    } catch (e) {
      // coordsAtPos may fail if view is detached
    }
  }

  function setCompletionActive(session, idx) {
    if (!session.completionMenu) return;
    const items = session.completionMenu.querySelectorAll(".pg4-menu-item");
    items.forEach((el, i) => {
      const active = i === idx;
      el.classList.toggle("active", active);
      el.setAttribute("aria-selected", active ? "true" : "false");
      if (active) el.scrollIntoView({ block: "nearest" });
    });
    session.completionActiveIdx = idx;
  }

  function applyCompletion(session, idx, from, to) {
    const item = session.completionItems?.[idx];
    if (!item) return;
    dispatchCompletion(session.view, from, to, item.insertText);
    // Record usage
    if (pg4.state.activeSnapshotId && item.symbolKey) {
      recordUsage(pg4.state.activeSnapshotId, item.symbolKey).catch(() => {});
    }
    hideCompletionMenu(session);
  }

  function hideCompletionMenu(session) {
    if (session.completionMenu) {
      session.completionMenu.style.display = "none";
      session.completionItems = [];
    }
  }

  function handleCompletionKeydown(session, ev) {
    if (!session.completionMenu || session.completionMenu.style.display === "none") return false;
    const items = session.completionItems ?? [];
    if (!items.length) return false;
    let idx = session.completionActiveIdx ?? 0;
    let handled = true;
    switch (ev.key) {
      case "ArrowDown": idx = (idx + 1) % items.length; break;
      case "ArrowUp": idx = (idx - 1 + items.length) % items.length; break;
      case "PageDown": idx = Math.min(items.length - 1, idx + 8); break;
      case "PageUp": idx = Math.max(0, idx - 8); break;
      case "Home": idx = 0; break;
      case "End": idx = items.length - 1; break;
      case "Enter":
      case "Tab":
        // Apply current selection (caller provides from/to via menu state)
        applyCompletion(session, idx, session.completionFrom ?? -1, session.completionTo ?? -1);
        ev.preventDefault();
        return true;
      case "Escape":
        hideCompletionMenu(session);
        ev.preventDefault();
        return true;
      default:
        handled = false;
    }
    if (handled) {
      setCompletionActive(session, idx);
      ev.preventDefault();
    }
    return handled;
  }

  // --- Hover card ---
  function showHoverCard(session, pos, content) {
    const shadow = ensureOverlayHost();
    const root = shadow.querySelector(".pg4-root");
    if (!session.hoverCard) {
      const card = document.createElement("div");
      card.className = "pg4-hover";
      card.style.cssText = `
        position: fixed; pointer-events: auto;
        background: var(--pg4-bg-elevated); color: var(--pg4-fg);
        border: 1px solid var(--pg4-border); border-radius: 6px;
        box-shadow: var(--pg4-shadow); padding: 8px 12px;
        max-width: 420px; font-size: 12px; z-index: 2147483647;
        white-space: pre-wrap; line-height: 1.5;
      `;
      root.appendChild(card);
      session.hoverCard = card;
    }
    const card = session.hoverCard;
    card.innerHTML = formatHoverContent(content);
    card.style.display = "block";
    try {
      const coords = session.view.coordsAtPos(pos);
      card.style.top = (coords.bottom + 4) + "px";
      card.style.left = coords.left + "px";
      // Flip if overflow
      const r = card.getBoundingClientRect();
      if (r.right > window.innerWidth - 8) card.style.left = (window.innerWidth - r.width - 8) + "px";
      if (r.bottom > window.innerHeight - 8) card.style.top = (coords.top - r.height - 4) + "px";
    } catch {}
  }

  function formatHoverContent(content) {
    if (typeof content === "string") return escapeHtml(content);
    if (content && typeof content === "object") {
      const lines = [];
      if (content.qualifiedName) lines.push(`<b>${escapeHtml(content.qualifiedName)}</b>`);
      if (content.relationKind) lines.push(`Kind: <code>${escapeHtml(content.relationKind)}</code>`);
      if (content.columnCount !== undefined) lines.push(`Columns: ${content.columnCount}`);
      if (content.type) lines.push(`Type: <code>${escapeHtml(content.type)}</code>`);
      if (content.nullable !== undefined) lines.push(content.nullable ? "Nullable" : "NOT NULL");
      if (content.defaultExpression) lines.push(`Default: <code>${escapeHtml(content.defaultExpression)}</code>`);
      if (content.isPrimaryKey) lines.push("🔑 Primary key");
      if (content.foreignKey) {
        lines.push(content.fkTarget
          ? `🔗 Foreign key → <code>${escapeHtml(content.fkTarget)}</code>`
          : "🔗 Foreign key");
      }
      if (content.pkColumns) lines.push(`🔑 PK: <code>${escapeHtml(content.pkColumns)}</code>`);
      if (content.comment) lines.push(escapeHtml(content.comment));
      if (content.jsonbPaths) lines.push(`JSONB paths: ${content.jsonbPaths}`);
      return lines.join("<br>");
    }
    return "";
  }

  // Full relation node from the schema index (summary refs from the relation
  // map lack comment/nullable/default/jsonbPaths — the full node has them).
  function findFullRelation(graph, ref) {
    return graph?._index?.relationByName?.[ref.key] ?? null;
  }

  function buildColumnHover(graph, ref, colTok) {
    const colKey = foldKey(colTok.value ?? colTok.text, colTok.type === "quoted-identifier");
    const full = findFullRelation(graph, ref);
    const col = full?.columns?.find(c => c.key === colKey) ?? ref.columns?.find(c => c.key === colKey);
    if (!col) return null;
    const content = {
      qualifiedName: `${ref.alias ?? ref.name}.${col.name}`,
      type: col.dataType,
      nullable: col.nullable !== false,
      isPrimaryKey: !!col.isPrimaryKey,
    };
    if (col.foreignKey) {
      content.foreignKey = true;
      content.fkTarget = `${col.foreignKey.referencedSchema}.${col.foreignKey.referencedTable}`;
    }
    if (col.defaultExpression) content.defaultExpression = col.defaultExpression;
    if (col.comment) content.comment = col.comment;
    if (Array.isArray(col.jsonbPaths) && col.jsonbPaths.length) {
      const shown = col.jsonbPaths.slice(0, 8).map(p => {
        const path = p.displayPath ?? (Array.isArray(p.segments) ? p.segments.join(".") : "");
        return p.valueType ? `${path}: ${p.valueType}` : path;
      });
      content.jsonbPaths = shown.join(", ") + (col.jsonbPaths.length > 8 ? " …" : "");
    }
    return content;
  }

  function buildRelationHover(graph, ref) {
    const full = findFullRelation(graph, ref);
    const content = {
      qualifiedName: `${ref.schema}.${ref.name}` + (ref.alias && ref.alias !== ref.name ? ` (AS ${ref.alias})` : ""),
      relationKind: full?.kind ?? "relation",
      columnCount: full?.columns?.length ?? ref.columns?.length ?? 0,
    };
    if (full?.primaryKey?.length) {
      content.pkColumns = full.primaryKey.map(k => {
        const c = full.columns?.find(x => x.key === k);
        return c?.name ?? k;
      }).join(", ");
    }
    if (full?.comment) content.comment = full.comment;
    return content;
  }

  function hideHoverCard(session) {
    if (session.hoverCard) session.hoverCard.style.display = "none";
  }

  // --- Diagnostics overlay ---
  function renderDiagnosticsOverlay(session, diags) {
    const shadow = ensureOverlayHost();
    const root = shadow.querySelector(".pg4-root");
    if (!session.diagLayer) {
      const layer = document.createElement("div");
      layer.className = "pg4-diag-layer";
      layer.style.cssText = `
        position: fixed; pointer-events: none;
        inset: 0; z-index: 2147483646; overflow: hidden;
      `;
      const style = document.createElement("style");
      style.textContent = `
        .pg4-diag-mark { position: absolute; height: 2px; background: transparent; border-bottom: 2px wavy var(--pg4-error); pointer-events: auto; }
        .pg4-diag-mark.warn { border-bottom-color: var(--pg4-warn); }
        .pg4-diag-tooltip { position: fixed; pointer-events: auto; background: var(--pg4-bg-elevated); color: var(--pg4-fg); border: 1px solid var(--pg4-border); border-radius: 4px; padding: 4px 8px; font-size: 11px; max-width: 320px; box-shadow: var(--pg4-shadow); z-index: 2147483647; }
      `;
      layer.appendChild(style);
      root.appendChild(layer);
      session.diagLayer = layer;
      // Re-position on scroll/resize
      let raf = null;
      session.diagReposition = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = null;
          positionDiagMarks(session);
        });
      };
      session.view.dom.addEventListener("scroll", session.diagReposition, { passive: true });
      window.addEventListener("resize", session.diagReposition, { passive: true });
    }
    // Clear previous marks
    session.diagLayer.querySelectorAll(".pg4-diag-mark, .pg4-diag-tooltip").forEach(n => n.remove());
    session.diagData = diags;
    // Render up to 100 marks; only viewport visible for >100
    const slice = diags.slice(0, 100);
    for (const d of slice) {
      const mark = document.createElement("div");
      mark.className = "pg4-diag-mark" + (d.severity === "warning" ? " warn" : "");
      mark.dataset.from = String(d.from);
      mark.dataset.to = String(d.to);
      mark.dataset.message = d.message;
      mark.title = d.message;
      mark.addEventListener("mouseenter", (ev) => {
        const tip = document.createElement("div");
        tip.className = "pg4-diag-tooltip";
        tip.textContent = d.message;
        tip.style.left = ev.clientX + 8 + "px";
        tip.style.top = ev.clientY + 8 + "px";
        session.diagLayer.appendChild(tip);
        session._lastTip = tip;
      });
      mark.addEventListener("mouseleave", () => {
        if (session._lastTip) { session._lastTip.remove(); session._lastTip = null; }
      });
      session.diagLayer.appendChild(mark);
    }
    positionDiagMarks(session);
  }

  function positionDiagMarks(session) {
    if (!session.diagLayer || !session.diagData) return;
    const marks = session.diagLayer.querySelectorAll(".pg4-diag-mark");
    marks.forEach(mark => {
      const from = +mark.dataset.from;
      const to = +mark.dataset.to;
      try {
        const startCoords = session.view.coordsAtPos(from);
        const endCoords = session.view.coordsAtPos(to);
        const left = Math.min(startCoords.left, endCoords.left);
        const top = startCoords.bottom - 2;
        const width = Math.max(8, Math.abs(endCoords.left - startCoords.left));
        mark.style.left = left + "px";
        mark.style.top = top + "px";
        mark.style.width = width + "px";
        mark.style.display = "";
      } catch {
        mark.style.display = "none";
      }
    });
  }

  function hideDiagnostics(session) {
    if (session.diagLayer) {
      session.diagLayer.querySelectorAll(".pg4-diag-mark, .pg4-diag-tooltip").forEach(n => n.remove());
      session.diagData = null;
    }
  }

  // --- Danger dialog ---
  function showDangerDialog(danger, opts = {}) {
    return new Promise((resolve) => {
      const shadow = ensureOverlayHost();
      const root = shadow.querySelector(".pg4-root");
      const backdrop = document.createElement("div");
      backdrop.className = "pg4-danger-backdrop";
      backdrop.style.cssText = `
        position: fixed; inset: 0; background: rgba(0,0,0,.4);
        display: flex; align-items: center; justify-content: center;
        pointer-events: auto; z-index: 2147483647;
      `;
      const dialog = document.createElement("div");
      dialog.className = "pg4-danger-dialog";
      dialog.style.cssText = `
        background: var(--pg4-bg-elevated); color: var(--pg4-fg);
        border: 1px solid var(--pg4-error); border-radius: 8px;
        padding: 20px; min-width: 360px; max-width: 480px;
        box-shadow: var(--pg4-shadow);
      `;
      const title = document.createElement("h3");
      title.textContent = "⚠ 危险语句拦截";
      title.style.cssText = `margin: 0 0 12px; color: var(--pg4-error); font-size: 16px;`;
      dialog.appendChild(title);
      const rows = [
        ["类别", danger.kind],
        ["目标对象", danger.target || "<unknown>"],
        ["风险原因", danger.reason],
        ["严重程度", danger.severity],
      ];
      for (const [k, v] of rows) {
        const row = document.createElement("div");
        row.style.cssText = "margin: 4px 0; font-size: 13px;";
        row.innerHTML = `<b style="display:inline-block;width:80px;color:var(--pg4-fg-muted);">${escapeHtml(k)}:</b> <span>${escapeHtml(String(v))}</span>`;
        dialog.appendChild(row);
      }
      const btns = document.createElement("div");
      btns.style.cssText = "display:flex; gap:8px; justify-content:flex-end; margin-top:16px;";
      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "取消";
      cancelBtn.style.cssText = "padding: 6px 14px; cursor: pointer; border: 1px solid var(--pg4-border); background: transparent; color: var(--pg4-fg); border-radius: 4px;";
      cancelBtn.onclick = () => { cleanup(); resolve("cancel"); };
      const continueBtn = document.createElement("button");
      continueBtn.textContent = "继续执行";
      continueBtn.style.cssText = "padding: 6px 14px; cursor: pointer; border: 1px solid var(--pg4-error); background: var(--pg4-error); color: #fff; border-radius: 4px;";
      continueBtn.onclick = () => { cleanup(); resolve("continue"); };
      btns.appendChild(cancelBtn);
      if (canExplainStatement(opts.sql ?? "")) {
        const explainBtn = document.createElement("button");
        explainBtn.textContent = "预估影响行数";
        explainBtn.style.cssText = "padding: 6px 14px; cursor: pointer; border: 1px solid var(--pg4-warn); background: transparent; color: var(--pg4-warn); border-radius: 4px;";
        explainBtn.onclick = () => { cleanup(); resolve("explain"); };
        btns.appendChild(explainBtn);
      }
      btns.appendChild(continueBtn);
      dialog.appendChild(btns);
      backdrop.appendChild(dialog);
      root.appendChild(backdrop);
      function cleanup() {
        try { backdrop.remove(); } catch {}
        document.removeEventListener("keydown", escHandler);
      }
      function escHandler(ev) {
        if (ev.key === "Escape") { cleanup(); resolve("cancel"); }
      }
      document.addEventListener("keydown", escHandler);
    });
  }

  // ┌─────────────────────────────────────────────────────────────────┐
  // │ Stage 8: Editor enhancements (smart paste / danger / Ctrl+Space) │
  // └─────────────────────────────────────────────────────────────────┘

  // --- Smart paste ---
  // Trigger only when pasting pure text (no newlines, ≤256 chars, no quotes).
  // Context-aware: wrap text/uuid/date values in single quotes for WHERE/VALUES,
  // wrap identifiers containing uppercase/space/special in double quotes.
  function handlePaste(ev) {
    if (CONFIG.pasteMode === "off") return;
    const text = ev.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    // Conditions: no newlines, ≤256 chars, contains no quotes
    if (text.includes("\n")) return;
    if (text.length > 256) return;
    if (text.includes("'") || text.includes('"')) return;

    // Find session owning the active element (CM6 editor)
    const el = ev.target?.closest?.(".cm-editor");
    if (!el) return;
    const sess = el.__pg4EditorId ? pg4.state.editors.get(el.__pg4EditorId) : null;
    if (!sess) return;

    try {
      const sql = sess.view.state.doc.toString();
      const cursor = sess.view.state.selection.main.head;
      const ctx = buildCompletionContext(sql, cursor, pg4.state.activeGraph);

      let insertText = text;
      if (CONFIG.pasteMode === "quotes") {
        const slot = classifyPasteSlot(sql, cursor, ctx);
        if (slot === "string") {
          // Value slot: if not numeric/boolean/null literal, wrap in single quotes
          const isNumeric = /^-?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(text);
          const isLiteral = /^(true|false|null)$/i.test(text);
          if (!isNumeric && !isLiteral) {
            insertText = "'" + text.replace(/'/g, "''") + "'";
          }
        } else if (slot === "identifier") {
          // Identifier slot: wrap in double quotes if contains uppercase/space/special
          if (/[A-Z\s\-]/.test(text) && !/^\d/.test(text)) {
            insertText = '"' + text.replace(/"/g, '""') + '"';
          }
        }
      }

      if (insertText !== text) {
        ev.preventDefault();
        // Replace the current selection (paste semantics), not the typed prefix
        const sel = sess.view.state.selection.main;
        dispatchCompletion(sess.view, sel.from, sel.to, insertText);
      }
    } catch (e) {
      // silent degrade — native paste will proceed
    }
  }

  // Classify the slot under the cursor for smart paste.
  // "string" = value slot (wrap in single quotes unless numeric/bool/null);
  // "identifier" = name slot (wrap in double quotes only when needed);
  // null = no wrapping.
  function classifyPasteSlot(sql, cursor, ctx) {
    // Trust the context parser when it already knows the slot
    if (ctx.kind === "insert-value") return "string";
    if (ctx.kind === "column" || ctx.kind === "qualified-column") return "identifier";
    // Look-back heuristics — covers value slots the parser reports as "unknown",
    // e.g. `WHERE name = <paste>` / `VALUES (<paste>)` / `IN (<paste>)` / `LIKE <paste>`
    const before = sql.slice(Math.max(0, cursor - 32), cursor).trimEnd();
    if (/[<>=!]{1,2}\s*$/.test(before)) {
      // comparison operator ( = != <> < > <= >= ) directly before cursor → value slot
      return "string";
    }
    if (/\b(VALUES|IN)\s*\(\s*[,]?\s*$/i.test(before)) return "string";
    if (/\bLIKE$/i.test(before)) return "string";
    // Identifier slots: right after clause keywords or list separators
    if (/\b(SELECT(\s+DISTINCT)?|FROM|JOIN|INTO|UPDATE|SET|WHERE|AND|OR|ON|GROUP\s+BY|ORDER\s+BY|TABLE)$/i.test(before)) return "identifier";
    if (/,$/.test(before)) return "identifier";
    return null;
  }

  // --- Danger click intercept ---
  // Match pgAdmin's "Execute" button via aria-label / class / tooltip.
  const EXECUTE_BUTTON_SELECTORS = [
    'button[aria-label*="Execute" i]',
    'button[aria-label*="执行" i]',
    'button[data-action="execute"]',
    'button[data-test="execute-query"]',
    '.pgadmin-query-tool button[data-label="execute"]',
  ];

  function isExecuteButton(el) {
    if (!el || el.tagName !== "BUTTON") return false;
    for (const sel of EXECUTE_BUTTON_SELECTORS) {
      try { if (el.matches(sel)) return true; } catch {}
    }
    // Fallback: pgAdmin play icon button
    if (el.classList.contains("play") || el.querySelector("i.fa-play, i.fa-caret-right")) return true;
    return false;
  }

  let __pg4BypassClick = false;

  // Query history recording — write-only (no UI per spec);
  // addQueryHistory prunes to MAX_HISTORY_ROWS via the executedAt index.
  function recordQueryHistory(session, sql) {
    try {
      const trimmed = (sql || "").trim();
      if (!trimmed) return;
      addQueryHistory({
        sql: trimmed.slice(0, 64 * 1024),
        executedAt: Date.now(),
        snapshotId: pg4.state.activeSnapshotId ?? null,
        editorId: session.editorId,
      }).catch(() => {});
    } catch {}
  }

  function handleExecuteClickCapture(ev) {
    if (__pg4BypassClick) return; // re-dispatched by us — let it through
    const target = ev.target?.closest?.("button");
    if (!isExecuteButton(target)) return;

    // Find the editor session — assume the active editor (closest .cm-editor to button or just the first)
    let sess = null;
    const tool = target.closest(".pgadmin-query-tool, .query-tool, [data-testid='query-tool']");
    if (tool) {
      const ed = tool.querySelector(".cm-editor");
      if (ed?.__pg4EditorId) sess = pg4.state.editors.get(ed.__pg4EditorId);
    }
    if (!sess && pg4.state.editors.size) {
      // fallback to most-recent editor
      sess = [...pg4.state.editors.values()].pop();
    }
    if (!sess) return;

    const sql = sess.view.state.doc.toString();

    // Record to query history on every execute click (independent of danger switch)
    recordQueryHistory(sess, sql);

    if (!CONFIG.dangerInterceptEnabled) return;
    const danger = quickDetectDangerSync(sql);
    if (!danger) return;

    // Intercept
    ev.preventDefault();
    ev.stopImmediatePropagation();

    (async () => {
      const action = await showDangerDialog(danger, { sql });
      if (action === "continue") {
        // Re-dispatch click with bypass flag
        __pg4BypassClick = true;
        try {
          target.click();
        } finally {
          // Reset flag on next tick
          setTimeout(() => { __pg4BypassClick = false; }, 0);
        }
      } else if (action === "explain") {
        // Wrap SQL with EXPLAIN and dispatch
        const explainSql = "EXPLAIN " + sql;
        try {
          sess.view.dispatch({
            changes: { from: 0, to: sess.view.state.doc.length, insert: explainSql },
            selection: { anchor: explainSql.length },
            userEvent: "input",
          });
          log("danger: rewrote to EXPLAIN, click Execute again to run");
        } catch (e) {
          warn("explain rewrite failed:", e?.message || e);
        }
      } else {
        // Cancel — do nothing
        log("danger: cancelled by user");
      }
    })();
  }

  // --- Ctrl+Space force completion ---
  function matchShortcut(ev, sc) {
    if (!sc) return false;
    if (sc.ctrl !== (ev.ctrlKey || ev.metaKey)) return false;
    if (sc.alt !== !!ev.altKey) return false;
    if (sc.shift !== !!ev.shiftKey) return false;
    if (sc.key && sc.key !== ev.key) return false;
    return true;
  }

  function handleKeydown(ev) {
    const el = ev.target?.closest?.(".cm-editor");
    if (!el) return;
    const sess = el.__pg4EditorId ? pg4.state.editors.get(el.__pg4EditorId) : null;
    if (!sess) return;

    // 1) If completion menu is open, let menu keys take priority
    if (handleCompletionKeydown(sess, ev)) return;

    // 2) Ctrl+Space force trigger
    if (matchShortcut(ev, CONFIG.completionShortcut)) {
      ev.preventDefault();
      triggerCompletion(sess, /*force=*/true);
      return;
    }
  }

  // --- Completion trigger pipeline (debounced) ---
  let completionDebounceTimers = new Map();

  function triggerCompletion(session, force = false) {
    const editorId = session.editorId;
    if (completionDebounceTimers.has(editorId)) {
      clearTimeout(completionDebounceTimers.get(editorId));
    }
    const delay = force ? 0 : CONFIG.completionDebounceMs;
    const t = setTimeout(async () => {
      completionDebounceTimers.delete(editorId);
      try {
        const sql = session.view.state.doc.toString();
        const cursor = session.view.state.selection.main.head;
        const graph = pg4.state.activeGraph;
        const ctx = await callWorker("buildCompletionContext", { sql, cursor, graph });
        // Auto-trigger conditions: 2 chars after boundary, or after . / -> / ->> / #> / #>>
        if (!force && ctx.kind === "unknown") {
          hideCompletionMenu(session);
          return;
        }
        if (!force && CONFIG.completionTriggerMode === "auto") {
          if (ctx.prefix.length < 2 && ctx.kind !== "qualified-column" && ctx.kind !== "jsonb-path") {
            hideCompletionMenu(session);
            return;
          }
        }
        const usageMap = pg4.state.activeSnapshotId
          ? await getUsageMap(pg4.state.activeSnapshotId).catch(() => new Map())
          : new Map();
        const items = await callWorker("generateCandidates", { ctx, graph, usageMap });
        items.prefix = ctx.prefix;
        session.completionFrom = ctx.from;
        session.completionTo = ctx.to;
        showCompletionMenu(session, items, ctx.from, ctx.to);
      } catch (e) {
        warn("completion trigger error:", e?.message || e);
        hideCompletionMenu(session);
      }
    }, delay);
    completionDebounceTimers.set(editorId, t);
  }

  // --- Hover pipeline (debounced) ---
  let hoverDebounceTimers = new Map();

  function handleMouseover(ev) {
    const el = ev.target?.closest?.(".cm-editor");
    if (!el) return;
    const sess = el.__pg4EditorId ? pg4.state.editors.get(el.__pg4EditorId) : null;
    if (!sess) return;
    const graph = pg4.state.activeGraph;
    if (!graph) return;

    const editorId = sess.editorId;
    if (hoverDebounceTimers.has(editorId)) clearTimeout(hoverDebounceTimers.get(editorId));
    const t = setTimeout(async () => {
      hoverDebounceTimers.delete(editorId);
      try {
        const pos = sess.view.posAtCoords({ x: ev.clientX, y: ev.clientY });
        if (pos == null) return;
        const sql = sess.view.state.doc.toString();
        const tokens = tokenize(sql);
        const sig = significantTokens(tokens);
        // Find token at pos
        let tok = null;
        for (const t of sig) {
          if (t.start <= pos && t.end >= pos) { tok = t; break; }
          if (t.start > pos) break;
        }
        if (!tok) return;
        const idx = sig.indexOf(tok);
        const prev = sig[idx - 1];
        const next = sig[idx + 1];
        let content = null;
        const stmt = findStatementAtCursor(sig, pos);
        if (stmt) {
          const rm = buildRelationMap(stmt.tokens, graph);
          if (prev?.text === ".") {
            // <alias|relation|schema>.<…> — column or relation hover
            const aliasTok = sig[idx - 2];
            if (aliasTok && (aliasTok.type === "identifier" || aliasTok.type === "quoted-identifier")) {
              const aliasKey = foldKey(aliasTok.value ?? aliasTok.text, aliasTok.type === "quoted-identifier");
              const ref = rm.byAlias.get(aliasKey) ?? rm.byName.get(aliasKey);
              if (ref) {
                // hovering the relation part of `rel.col` shows the relation card;
                // hovering the column part shows the column card
                content = next?.text === "."
                  ? buildRelationHover(graph, ref)
                  : buildColumnHover(graph, ref, tok);
              } else if (next?.text === ".") {
                // schema.relation.column — resolve the relation via the schema index
                const relKey = `${aliasKey}.${foldKey(tok.value ?? tok.text, tok.type === "quoted-identifier")}`;
                const rel = graph._index?.relationByName?.[relKey];
                if (rel) {
                  content = buildRelationHover(graph, {
                    key: relKey, schema: aliasTok.value ?? aliasTok.text,
                    name: rel.name, alias: null, columns: rel.columns,
                  });
                }
              }
            }
          } else if (tok.type === "identifier" || tok.type === "quoted-identifier") {
            // <relation|alias>. … or a bare relation name in FROM/JOIN — relation hover
            const aliasKey = foldKey(tok.value ?? tok.text, tok.type === "quoted-identifier");
            const ref = rm.byAlias.get(aliasKey) ?? rm.byName.get(aliasKey);
            if (ref) content = buildRelationHover(graph, ref);
          }
        }
        if (content) {
          showHoverCard(sess, pos, content);
        }
      } catch (e) {
        // silent
      }
    }, CONFIG.hoverDebounceMs);
    hoverDebounceTimers.set(editorId, t);
  }

  function handleMouseout(ev) {
    const el = ev.target?.closest?.(".cm-editor");
    if (!el) return;
    const sess = el.__pg4EditorId ? pg4.state.editors.get(el.__pg4EditorId) : null;
    if (!sess) return;
    // Hide after leave delay
    setTimeout(() => {
      // Only hide if not moved into the hover card itself
      // (Simplified: always hide after delay)
      hideHoverCard(sess);
    }, CONFIG.hoverLeaveDelayMs);
  }

  // --- Diagnostics pipeline (debounced) ---
  let diagDebounceTimers = new Map();

  function scheduleDiagnostics(session) {
    if (!CONFIG.diagnosticsEnabled) return;
    const editorId = session.editorId;
    if (diagDebounceTimers.has(editorId)) clearTimeout(diagDebounceTimers.get(editorId));
    const t = setTimeout(async () => {
      diagDebounceTimers.delete(editorId);
      try {
        const sql = session.view.state.doc.toString();
        // For >500KB docs, only diagnose current statement
        let sqlToDiag = sql;
        if (sql.length > 500 * 1024) {
          const cursor = session.view.state.selection.main.head;
          const tokens = tokenize(sql);
          const sig = significantTokens(tokens);
          const stmt = findStatementAtCursor(sig, cursor);
          if (stmt) sqlToDiag = sql.slice(stmt.start, stmt.end);
        }
        const diags = await callWorker("runDiagnostics", { sql: sqlToDiag, graph: pg4.state.activeGraph });
        renderDiagnosticsOverlay(session, diags);
      } catch (e) {
        warn("diag schedule error:", e?.message || e);
      }
    }, CONFIG.diagnosticsDebounceMs);
    diagDebounceTimers.set(editorId, t);
  }

  // Wire view.updateListener to refresh overlays when doc changes
  function attachViewUpdateListener(session) {
    if (!session.view) return;
    try {
      // Wrap dispatch to detect doc changes (simplified: hook via DOM input events)
      session.el.addEventListener("input", () => {
        scheduleDiagnostics(session);
        // If user is typing, hide hover card immediately
        hideHoverCard(session);
        // Auto-trigger completion while typing ("manual" mode = Ctrl+Space only).
        // Programmatic view.dispatch (e.g. applying a candidate) does not fire
        // native `input` events, so no re-trigger loop occurs.
        if (CONFIG.completionTriggerMode === "auto") {
          triggerCompletion(session, /*force=*/false);
        }
      }, { passive: true });
    } catch {}
  }

  // ┌─────────────────────────────────────────────────────────────────┐
  // │ Stage 9: Floating button + drawer (control panel UI)             │
  // └─────────────────────────────────────────────────────────────────┘

  function injectFloatingButton() {
    if (pg4.state.floatingButton) return;
    const shadow = ensureOverlayHost();
    const root = shadow.querySelector(".pg4-root");
    const btn = document.createElement("button");
    btn.className = "pg4-fab";
    btn.setAttribute("aria-label", "PG4 Smart Assist");
    btn.setAttribute("title", "PG4 Smart Assist");
    btn.innerHTML = "&#9881;"; // gear
    btn.style.cssText = `
      position: fixed; bottom: 16px; right: 16px;
      width: 48px; height: 48px; border-radius: 50%;
      background: var(--pg4-bg-elevated); color: var(--pg4-fg);
      border: 1px solid var(--pg4-border);
      box-shadow: var(--pg4-shadow);
      cursor: pointer; opacity: 0.5;
      font-size: 22px; line-height: 1; pointer-events: auto;
      transition: opacity 0.15s; z-index: 2147483647;
      display: flex; align-items: center; justify-content: center;
    `;
    btn.addEventListener("mouseenter", () => { btn.style.opacity = "1"; });
    btn.addEventListener("mouseleave", () => { btn.style.opacity = "0.5"; });
    btn.addEventListener("click", () => toggleDrawer());
    root.appendChild(btn);
    pg4.state.floatingButton = btn;
  }

  function toggleDrawer() {
    if (!pg4.state.drawer) {
      buildDrawer();
      pg4.state.drawer.style.display = "block";
      refreshDrawerLists();
    } else if (pg4.state.drawer.style.display === "none") {
      pg4.state.drawer.style.display = "block";
      refreshDrawerLists();
    } else {
      pg4.state.drawer.style.display = "none";
    }
  }

  function buildDrawer() {
    const shadow = ensureOverlayHost();
    const root = shadow.querySelector(".pg4-root");
    const drawer = document.createElement("div");
    drawer.className = "pg4-drawer";
    drawer.style.cssText = `
      position: fixed; bottom: 72px; right: 16px;
      width: 360px; max-height: 80vh; overflow-y: auto;
      background: var(--pg4-bg-elevated); color: var(--pg4-fg);
      border: 1px solid var(--pg4-border); border-radius: 8px;
      box-shadow: var(--pg4-shadow); padding: 12px;
      pointer-events: auto; z-index: 2147483647;
      font-size: 13px;
    `;
    // Sections: Import / Switch / Delete
    drawer.innerHTML = `
      <style>
        .pg4-drawer h2 { font-size: 13px; margin: 0 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--pg4-border); }
        .pg4-drawer section { margin-bottom: 16px; }
        .pg4-drawer label { display: block; font-size: 11px; color: var(--pg4-fg-muted); margin: 4px 0; }
        .pg4-drawer input[type=text] { width: 100%; padding: 4px 6px; box-sizing: border-box; background: var(--pg4-bg); color: var(--pg4-fg); border: 1px solid var(--pg4-border); border-radius: 4px; }
        .pg4-drawer button.pg4-btn { padding: 4px 10px; cursor: pointer; border: 1px solid var(--pg4-border); background: var(--pg4-bg); color: var(--pg4-fg); border-radius: 4px; font-size: 12px; }
        .pg4-drawer button.pg4-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .pg4-drawer .pg4-drop-zone { border: 2px dashed var(--pg4-border); padding: 12px; text-align: center; border-radius: 4px; cursor: pointer; margin: 4px 0; }
        .pg4-drawer .pg4-drop-zone.drag { border-color: var(--pg4-accent); background: rgba(9,105,218,.05); }
        .pg4-drawer .pg4-snap-row { display: flex; align-items: center; padding: 4px 0; gap: 6px; border-bottom: 1px solid var(--pg4-border); }
        .pg4-drawer .pg4-snap-row:last-child { border-bottom: none; }
        .pg4-drawer .pg4-snap-meta { flex: 1; }
        .pg4-drawer .pg4-snap-name { font-weight: 500; }
        .pg4-drawer .pg4-snap-info { font-size: 11px; color: var(--pg4-fg-muted); }
        .pg4-drawer .pg4-warn-list { font-size: 11px; color: var(--pg4-warn); margin-top: 4px; max-height: 100px; overflow-y: auto; }
        .pg4-drawer .pg4-empty { color: var(--pg4-fg-muted); font-size: 12px; padding: 8px 0; }
      </style>
      <section>
        <h2>📦 导入快照</h2>
        <div class="pg4-drop-zone" id="pg4-drop-zone">
          拖拽 DDL 文件至此<br>
          <span style="font-size:11px;color:var(--pg4-fg-muted);">或点击选择 .sql/.txt/.ddl</span>
        </div>
        <input type="file" id="pg4-file-input" accept=".sql,.txt,.ddl" style="display:none;">
        <label>快照名称</label>
        <input type="text" id="pg4-snap-name" placeholder="导入后自动填充">
        <div style="margin-top:8px;">
          <button class="pg4-btn" id="pg4-import-btn" disabled>导入</button>
          <span id="pg4-import-status" style="margin-left:8px;font-size:11px;color:var(--pg4-fg-muted);"></span>
        </div>
        <div class="pg4-warn-list" id="pg4-warn-list" style="display:none;"></div>
      </section>
      <section>
        <h2>🔁 切换活跃快照</h2>
        <div id="pg4-switch-list"></div>
      </section>
      <section>
        <h2>🗑 删除快照</h2>
        <div id="pg4-delete-list"></div>
      </section>
    `;
    root.appendChild(drawer);
    pg4.state.drawer = drawer;

    // Escape closes drawer
    drawer.tabIndex = -1;
    drawer.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { drawer.style.display = "none"; ev.stopPropagation(); }
    });

    wireImportSection(drawer);
  }

  function wireImportSection(drawer) {
    const dropZone = drawer.querySelector("#pg4-drop-zone");
    const fileInput = drawer.querySelector("#pg4-file-input");
    const nameInput = drawer.querySelector("#pg4-snap-name");
    const importBtn = drawer.querySelector("#pg4-import-btn");
    const status = drawer.querySelector("#pg4-import-status");
    const warnList = drawer.querySelector("#pg4-warn-list");

    let pendingFile = null;
    let pendingText = null;

    const setFile = (file, text) => {
      pendingFile = file;
      pendingText = text;
      if (file) {
        const baseName = file.name.replace(/\.(sql|txt|ddl)$/i, "");
        nameInput.value = baseName;
        importBtn.disabled = false;
        status.textContent = `已选择: ${file.name} (${file.size} bytes)`;
      } else {
        nameInput.value = "";
        importBtn.disabled = true;
        status.textContent = "";
      }
      warnList.style.display = "none";
      warnList.innerHTML = "";
    };

    dropZone.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      const text = await f.text();
      setFile(f, text);
    });
    dropZone.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      dropZone.classList.add("drag");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag"));
    dropZone.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      dropZone.classList.remove("drag");
      const f = ev.dataTransfer?.files?.[0];
      if (!f) return;
      const text = await f.text();
      setFile(f, text);
    });

    importBtn.addEventListener("click", async () => {
      if (!pendingText) return;
      importBtn.disabled = true;
      importBtn.textContent = "导入中...";
      status.textContent = "解析中...";
      try {
        const displayName = nameInput.value.trim() || (pendingFile?.name ?? `snapshot-${Date.now()}`);
        const { meta, warnings } = await importSnapshotFromText(pendingText, displayName, pendingFile?.name);
        status.textContent = `✓ 导入成功：${meta.schemaCount} schemas, ${meta.relationCount} relations, ${warnings.length} warnings`;
        if (warnings.length) {
          warnList.style.display = "block";
          warnList.innerHTML = warnings.map(w => `<div>L${w.line}: [${w.code}] ${escapeHtml(w.message)}</div>`).join("");
        }
        // Reset
        setFile(null, null);
        refreshDrawerLists();
      } catch (e) {
        status.textContent = "✗ " + (e?.message || e);
        error("import failed:", e?.message || e);
      } finally {
        importBtn.textContent = "导入";
        importBtn.disabled = !pendingText;
      }
    });
  }

  // Core import pipeline: parse → JSONB annotate → index → persist → activate.
  // Shared by the drawer import button, the `.pg4snap.json` migration path, and
  // smoke/debug harnesses via window.__pg4.
  async function importSnapshotFromText(rawDdl, displayName, sourceFileName) {
    const totalDdl = await getAllSnapshotRawSizes();
    if (totalDdl + rawDdl.length > MAX_TOTAL_DDL_BYTES) {
      throw new Error(`DDL 总量超限（${totalDdl + rawDdl.length} > ${MAX_TOTAL_DDL_BYTES} bytes）`);
    }
    const name = displayName || sourceFileName || `snapshot-${Date.now()}`;
    const snapshotId = `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    // Parse. NOTE: in worker mode each call operates on a structured-clone,
    // so we must thread the RETURNED graph through the pipeline — annotating
    // a worker-side clone and discarding it would drop JSONB annotations.
    const parsed = await callWorker("parseDdl", { rawDdl, sourceFileName: sourceFileName ?? "<inline>" });
    const warnings = parsed.warnings ?? [];
    let graph = parsed.graph;
    graph.snapshotId = snapshotId;
    graph.displayName = name;
    graph = await callWorker("parseJsonb", { rawDdl, graph });
    const index = await callWorker("buildIndex", { graph });
    // Persist
    const meta = {
      snapshotId, displayName: name, sourceFileName: sourceFileName ?? "<inline>",
      importedAt: new Date().toISOString(),
      schemaCount: Object.keys(graph.schemas).length,
      relationCount: Object.values(graph.schemas).reduce((s, sc) => s + Object.keys(sc.relations).length, 0),
      warningCount: warnings.length,
    };
    await putSnapshot({ snapshotId, meta, rawDdl });
    await putSchemaGraphRow({ snapshotId, graph, index });
    // Auto-activate
    await activateSnapshot(snapshotId);
    log(`snapshot imported: ${name}, ${meta.schemaCount} schemas, ${meta.relationCount} relations, ${warnings.length} warnings`);
    return { snapshotId, meta, warnings };
  }

  async function refreshDrawerLists() {
    if (!pg4.state.drawer) return;
    const switchList = pg4.state.drawer.querySelector("#pg4-switch-list");
    const deleteList = pg4.state.drawer.querySelector("#pg4-delete-list");
    if (!switchList || !deleteList) return;
    let metas = [];
    try { metas = await listSnapshotMetas(); } catch {}
    const activeId = getActiveSnapshotId();
    if (!metas.length) {
      switchList.innerHTML = `<div class="pg4-empty">暂无快照</div>`;
      deleteList.innerHTML = `<div class="pg4-empty">暂无快照</div>`;
      return;
    }
    switchList.innerHTML = metas.map(m => `
      <div class="pg4-snap-row">
        <input type="radio" name="pg4-active" value="${escapeHtml(m.snapshotId)}" ${m.snapshotId === activeId ? "checked" : ""}>
        <div class="pg4-snap-meta">
          <div class="pg4-snap-name">${escapeHtml(m.displayName)}</div>
          <div class="pg4-snap-info">${m.schemaCount} schemas · ${m.relationCount} relations · ${new Date(m.importedAt).toLocaleString()}</div>
        </div>
      </div>
    `).join("");
    deleteList.innerHTML = metas.map(m => `
      <div class="pg4-snap-row">
        <div class="pg4-snap-meta">
          <div class="pg4-snap-name">${escapeHtml(m.displayName)}</div>
          <div class="pg4-snap-info">${m.schemaCount} schemas · ${m.relationCount} relations</div>
        </div>
        <button class="pg4-btn" data-del-id="${escapeHtml(m.snapshotId)}">删除</button>
      </div>
    `).join("");
    // Wire radio
    switchList.querySelectorAll('input[name="pg4-active"]').forEach(r => {
      r.addEventListener("change", async () => {
        if (r.checked) await activateSnapshot(r.value);
      });
    });
    // Wire delete
    deleteList.querySelectorAll("button[data-del-id]").forEach(b => {
      b.addEventListener("click", async () => {
        const id = b.dataset.delId;
        if (!confirm("确认删除此快照？此操作不可撤销。")) return;
        await deleteSnapshotRow(id);
        if (id === getActiveSnapshotId()) {
          setActiveSnapshotId(null);
          pg4.state.activeGraph = null;
          pg4.state.activeSnapshotId = null;
        }
        refreshDrawerLists();
        log("snapshot deleted:", id);
      });
    });
  }

  async function activateSnapshot(snapshotId) {
    const row = await getSchemaGraphRow(snapshotId);
    if (!row) {
      warn("activate: snapshot graph not found:", snapshotId);
      return;
    }
    // Build index if missing
    if (!row.graph._index) buildIndex(row.graph);
    pg4.state.activeGraph = row.graph;
    pg4.state.activeSnapshotId = snapshotId;
    setActiveSnapshotId(snapshotId);
    const schemaCount = Object.keys(row.graph.schemas).length;
    const relCount = Object.values(row.graph.schemas).reduce((s, sc) => s + Object.keys(sc.relations).length, 0);
    log(`active snapshot loaded: ${row.graph.displayName}, ${schemaCount} schemas, ${relCount} relations`);
    refreshDrawerLists();
    // Re-trigger diagnostics on all editors with new graph
    for (const sess of pg4.state.editors.values()) scheduleDiagnostics(sess);
  }

  // ┌─────────────────────────────────────────────────────────────────┐
  // │ Stage 10: Bootstrap (main flow)                                  │
  // └─────────────────────────────────────────────────────────────────┘

  async function bootstrap() {
    // Idempotency guard
    if (window.__pg4Active) {
      log("snippet: already active, skipping");
      return;
    }
    window.__pg4Active = true;

    try {
      // 1) Overlay host + theme detection
      ensureOverlayHost();

      // 2) IndexedDB probe
      try {
        await openDb();
      } catch (e) {
        warn("IndexedDB open failed:", e?.message || e);
      }

      // 3) Compute worker (Blob URL; falls back to main thread on CSP block)
      try {
        pg4.state.worker = await createComputeWorker();
        pg4.state.workerAvailable = !!pg4.state.worker;
      } catch (e) {
        pg4.state.worker = null;
        pg4.state.workerAvailable = false;
      }

      // 4) Load active snapshot
      const activeId = getActiveSnapshotId();
      if (activeId) {
        try {
          await activateSnapshot(activeId);
        } catch (e) {
          warn("active snapshot load failed:", e?.message || e);
          pg4.state.activeGraph = null;
          pg4.state.activeSnapshotId = null;
        }
      } else {
        log("no active snapshot, completion limited to keywords");
      }

      // 5) Scan for existing editors + register MutationObserver
      scanForEditors(document);
      startEditorMutationObserver();
      // Also scan iframes (same-origin only)
      try {
        for (const f of document.querySelectorAll("iframe")) {
          try {
            const doc = f.contentDocument;
            if (doc) scanForEditors(doc);
          } catch {}
        }
      } catch {}

      // 6) Register global event listeners (capture phase)
      document.addEventListener("keydown", handleKeydown, true);
      document.addEventListener("paste", handlePaste, true);
      document.addEventListener("click", handleExecuteClickCapture, true);
      document.addEventListener("mouseover", handleMouseover, true);
      document.addEventListener("mouseout", handleMouseout, true);

      // 7) Register storage event for cross-tab active snapshot sync
      window.addEventListener("storage", (ev) => {
        if (ev.key === PREFIX + "activeSnapshotId") {
          const newId = ev.newValue;
          if (newId && newId !== pg4.state.activeSnapshotId) {
            activateSnapshot(newId).catch(e => warn("storage sync activate failed:", e?.message || e));
          } else if (!newId) {
            pg4.state.activeGraph = null;
            pg4.state.activeSnapshotId = null;
            log("active snapshot cleared via storage event");
          }
        }
      });

      // 8) Inject floating button
      injectFloatingButton();

      // 9) Re-scan periodically (best-effort for late-loaded editors)
      let rescanTimer = null;
      const rescan = () => {
        if (rescanTimer) return;
        rescanTimer = setTimeout(() => {
          rescanTimer = null;
          scanForEditors(document);
          // Attach input listeners for newly-adopted editors
          for (const sess of pg4.state.editors.values()) {
            if (!sess.__inputWired) {
              attachViewUpdateListener(sess);
              sess.__inputWired = true;
            }
          }
        }, 1000);
      };
      setTimeout(rescan, 2000);
      setTimeout(rescan, 5000);

      log("snippet: started", {
        workerAvailable: pg4.state.workerAvailable,
        activeSnapshotId: pg4.state.activeSnapshotId,
        editors: pg4.state.editors.size,
      });

      // runMode = "overrides" works identically (snippet body runs on page load)
    } catch (e) {
      error("snippet: bootstrap error:", e?.message || e);
    }
  }

  // Debug / test handle — exposes pure algorithm functions for headless
  // verification (test/headless.mjs) and on-site console debugging.
  try {
    window.__pg4 = {
      CONFIG, state: pg4.state,
      tokenize, significantTokens, splitStatements,
      parseDdl, parseJsonbAnnotations, buildIndex,
      buildCompletionContext, generateCandidates, runDiagnostics,
      quickDetectDangerSync, stripSqlComments, classifyPasteSlot,
      buildWorkerSource, localCompute, importSnapshotFromText,
    };
  } catch {}

  // Run
  bootstrap().catch(e => error("snippet: uncaught:", e?.message || e));

  // === END ===
})();
