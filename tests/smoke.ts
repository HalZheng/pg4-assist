// Smoke test for the auto-completion fixes (user-reported issues).
// Pure-logic: imports context-parser + completion-engine; runs under node.
// Bundle + run:
//   npx esbuild tests/smoke.ts --bundle --platform=node --format=esm --outfile=dist-test/smoke.mjs && node dist-test/smoke.mjs
import assert from "node:assert/strict";
import { buildCompletionContext } from "../src/lib/context-parser";
import { buildCandidates } from "../src/lib/completion-engine";
import type { SchemaGraph, TableNode, ColumnNode } from "../src/types/schema-graph";

// ---- test schema fixture --------------------------------------------------

function makeColumn(name: string, baseType: string, opts: Partial<ColumnNode> = {}): ColumnNode {
  return {
    name,
    key: name.toLowerCase(),
    quoted: false,
    dataType: baseType,
    baseType,
    nullable: opts.nullable ?? true,
    defaultExpression: opts.defaultExpression,
    comment: opts.comment,
    ordinal: opts.ordinal ?? 0,
    isPrimaryKey: opts.isPrimaryKey ?? false,
    foreignKey: opts.foreignKey,
    jsonbPaths: opts.jsonbPaths,
  };
}

function makeTable(schema: string, name: string, quoted: boolean, columns: ColumnNode[]): TableNode {
  return {
    kind: "table",
    schema,
    name,
    key: `${schema.toLowerCase()}.${name.toLowerCase()}`,
    quoted,
    columns,
    primaryKey: columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
    foreignKeys: [],
    indexes: [],
  };
}

const graph: SchemaGraph = {
  snapshotId: "snap-test",
  displayName: "test",
  sourceFileName: "test.sql",
  importedAt: "2026-01-01",
  parserVersion: 1,
  schemas: {
    public: {
      name: "public",
      key: "public",
      quoted: false,
      relations: {
        "public.users": makeTable("public", "users", false, [
          makeColumn("id", "integer", { isPrimaryKey: true, ordinal: 1 }),
          makeColumn("name", "text", { ordinal: 2 }),
          makeColumn("email", "text", { ordinal: 3 }),
        ]),
        "public.orders": makeTable("public", "Orders", true, [
          // mixed-case name → must be quoted on insert
          makeColumn("id", "integer", { isPrimaryKey: true, ordinal: 1 }),
          makeColumn("user_id", "integer", { ordinal: 2 }),
          makeColumn("total", "numeric", { ordinal: 3 }),
        ]),
        "public.__EFConfigurationDbContextMigrationsHistory": makeTable(
          "public",
          "__EFConfigurationDbContextMigrationsHistory",
          false,
          [makeColumn("MigrationId", "varchar", { ordinal: 1 })]
        ),
        "public.pg_stat_statements": makeTable(
          "public",
          "pg_stat_statements",
          false,
          [makeColumn("query", "text", { ordinal: 1 })]
        ),
      },
    },
    pg_catalog: {
      name: "pg_catalog",
      key: "pg_catalog",
      quoted: false,
      relations: {
        "pg_catalog.pg_class": makeTable("pg_catalog", "pg_class", false, [
          makeColumn("relname", "name", { ordinal: 1 }),
        ]),
      },
    },
  },
  functions: [],
};

const deps = {
  graph,
  usage: [],
  snapshotId: "snap-test",
  localUsage: new Map<string, number>(),
  snippets: [],
  maxCandidates: 50,
  showSystemTables: false,
};

// ---- helpers ---------------------------------------------------------------

function ctxAt(sql: string, cursor = sql.length) {
  return buildCompletionContext({ sql, cursor, graph });
}

function labelsOf(items: { label: string }[]): string[] {
  return items.map((i) => i.label);
}

function insertTextOf(items: { label: string; insertText: string }[], label: string): string | undefined {
  return items.find((i) => i.label === label)?.insertText;
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(e as Error).message}`);
  }
}

// ---- scenarios (mapped to user complaints) ---------------------------------

console.log("\n[1] Typing 'select' suggests SELECT keyword (not functions)");
test("typing 'select' → keyword context, SELECT candidate present", () => {
  const sql = "select";
  const ctx = ctxAt(sql);
  assert.equal(ctx.kind, "keyword", `kind should be 'keyword' (got ${ctx.kind})`);
  assert.equal(ctx.prefix, "select");
  const { items } = buildCandidates(ctx, deps);
  const labels = labelsOf(items);
  assert.ok(labels.includes("SELECT"), `SELECT should be a candidate; got ${labels.slice(0, 10).join(", ")}`);
});

console.log("\n[2] Typing 'from' (no space) suggests keywords, NOT table names");
test("typing 'SELECT * from' (cursor at end of 'from') → keyword context", () => {
  const sql = "SELECT * from";
  const ctx = ctxAt(sql);
  assert.equal(ctx.kind, "keyword", `kind should be 'keyword' (got ${ctx.kind})`);
  assert.equal(ctx.prefix, "from");
  const { items } = buildCandidates(ctx, deps);
  const labels = labelsOf(items);
  // Should NOT include noise tables
  assert.ok(!labels.includes("users"), `users should not appear while typing 'from'; got ${labels.slice(0, 10).join(", ")}`);
  assert.ok(labels.includes("FROM"), `FROM keyword should be present; got ${labels.slice(0, 10).join(", ")}`);
});

console.log("\n[3] After 'FROM ' (with space) → relation context, tables suggested");
test("'SELECT * FROM ' → relation context, users table present", () => {
  const sql = "SELECT * FROM ";
  const ctx = ctxAt(sql);
  assert.equal(ctx.kind, "relation", `kind should be 'relation' (got ${ctx.kind})`);
  const { items } = buildCandidates(ctx, deps);
  const labels = labelsOf(items);
  assert.ok(labels.includes("users"), `users table should be suggested; got ${labels.slice(0, 10).join(", ")}`);
});

console.log("\n[4] Noise tables filtered by default (__EF*, pg_stat_*, pg_catalog.*)");
test("noise tables hidden when showSystemTables=false", () => {
  const sql = "SELECT * FROM ";
  const ctx = ctxAt(sql);
  const { items } = buildCandidates(ctx, deps);
  const labels = labelsOf(items);
  assert.ok(!labels.includes("__EFConfigurationDbContextMigrationsHistory"), "EF migration table should be filtered");
  assert.ok(!labels.includes("pg_stat_statements"), "pg_stat_* should be filtered");
});

test("noise tables shown when showSystemTables=true", () => {
  const sql = "SELECT * FROM ";
  const ctx = ctxAt(sql);
  const { items } = buildCandidates(ctx, { ...deps, showSystemTables: true });
  const labels = labelsOf(items);
  // pg_catalog.pg_class is in a system schema — should appear when showSystemTables=true.
  // (schema-qualified label is "pg_catalog.pg_class")
  assert.ok(
    labels.some((l) => l.includes("pg_class")),
    `pg_catalog.pg_class should be present when showSystemTables=true; got ${labels.slice(0, 10).join(", ")}`
  );
});

console.log("\n[5] Mixed-case table name 'Orders' gets double-quoted insertText");
test("Orders (quoted in DDL) → insertText is '\"Orders\"'", () => {
  const sql = "SELECT * FROM ord";
  const ctx = ctxAt(sql);
  assert.equal(ctx.kind, "relation", `kind should be 'relation' (got ${ctx.kind})`);
  const { items } = buildCandidates(ctx, deps);
  const ordersItem = items.find((i) => i.label === "Orders");
  assert.ok(ordersItem, `Orders should be a candidate; got ${labelsOf(items).slice(0, 10).join(", ")}`);
  assert.equal(ordersItem!.insertText, '"Orders"', `insertText should be "\"Orders\""; got ${ordersItem!.insertText}`);
});

test("lowercase table 'users' (unquoted) → insertText is bare 'users'", () => {
  const sql = "SELECT * FROM use";
  const ctx = ctxAt(sql);
  assert.equal(ctx.kind, "relation", `kind should be 'relation' (got ${ctx.kind})`);
  const { items } = buildCandidates(ctx, deps);
  const usersItem = items.find((i) => i.label === "users");
  assert.ok(usersItem, "users should be a candidate");
  assert.equal(usersItem!.insertText, "users", `insertText should be bare 'users'; got ${usersItem!.insertText}`);
});

test("reserved word 'user' after FROM → relation context (not keyword)", () => {
  // 'user' is a PG reserved word but here it's a table-name prefix.
  const sql = "SELECT * FROM user";
  const ctx = ctxAt(sql);
  assert.equal(ctx.kind, "relation", `typing a reserved word after FROM should be relation context (got ${ctx.kind})`);
  assert.equal(ctx.prefix, "user");
  const { items } = buildCandidates(ctx, deps);
  const labels = labelsOf(items);
  assert.ok(labels.includes("users"), `users table should be suggested for 'user' prefix; got ${labels.slice(0, 10).join(", ")}`);
});

console.log("\n[6] Typing 'where' (no space) → keyword context, not columns");
test("'SELECT * FROM users where' → keyword context with prefix 'where'", () => {
  const sql = "SELECT * FROM users where";
  const ctx = ctxAt(sql);
  assert.equal(ctx.kind, "keyword", `kind should be 'keyword' (got ${ctx.kind})`);
  assert.equal(ctx.prefix, "where");
  const { items } = buildCandidates(ctx, deps);
  const labels = labelsOf(items);
  assert.ok(labels.includes("WHERE"), `WHERE keyword should be present; got ${labels.slice(0, 10).join(", ")}`);
  // columns should not surface while still inside the keyword
  assert.ok(!labels.includes("id"), `column 'id' should not appear while typing 'where'`);
});

console.log("\n[7] After 'WHERE ' (with space) → column context");
test("'SELECT * FROM users WHERE ' → column context, column 'id' present", () => {
  const sql = "SELECT * FROM users WHERE ";
  const ctx = ctxAt(sql);
  assert.equal(ctx.kind, "column", `kind should be 'column' (got ${ctx.kind})`);
  const { items } = buildCandidates(ctx, deps);
  const labels = labelsOf(items);
  assert.ok(labels.includes("id"), `column 'id' should be present; got ${labels.slice(0, 10).join(", ")}`);
});

console.log("\n[8] Alias prefix on ambiguous columns (two tables both have 'id')");
test("'SELECT * FROM users u, orders o WHERE ' → ambiguous 'id' gets alias prefix", () => {
  const sql = "SELECT * FROM users u, Orders o WHERE i";
  const ctx = ctxAt(sql);
  assert.equal(ctx.kind, "column");
  const { items } = buildCandidates(ctx, deps);
  // both 'users' and 'Orders' are visible; both have 'id' column → ambiguous
  const idItem = items.find((i) => i.label === "id");
  assert.ok(idItem, `id column should be present; got ${labelsOf(items).slice(0, 10).join(", ")}`);
  assert.ok(
    idItem!.insertText === "u.id" || idItem!.insertText === "o.id",
    `ambiguous 'id' insertText should carry alias prefix (u.id or o.id); got ${idItem!.insertText}`
  );
});

test("unambiguous column 'email' (only in users) → bare insertText 'email'", () => {
  const sql = "SELECT * FROM users u, Orders o WHERE e";
  const ctx = ctxAt(sql);
  const { items } = buildCandidates(ctx, deps);
  const emailItem = items.find((i) => i.label === "email");
  assert.ok(emailItem, "email column should be present");
  assert.equal(emailItem!.insertText, "email", `email should be bare (no alias); got ${emailItem!.insertText}`);
});

console.log("\n[9] Qualified column context after 'alias.'");
test("'SELECT * FROM users u WHERE u.' → qualified-column context, columns of users", () => {
  const sql = "SELECT * FROM users u WHERE u.";
  const ctx = ctxAt(sql);
  assert.equal(ctx.kind, "qualified-column", `kind should be 'qualified-column' (got ${ctx.kind})`);
  assert.ok(ctx.activeRelation, "activeRelation should be resolved to users");
  assert.equal(ctx.activeRelation!.name, "users");
  const { items } = buildCandidates(ctx, deps);
  const labels = labelsOf(items);
  assert.ok(labels.includes("id"), `id should be present; got ${labels.slice(0, 10).join(", ")}`);
  assert.ok(labels.includes("email"), `email should be present; got ${labels.slice(0, 10).join(", ")}`);
});

console.log("\n[10] JOIN clause still parses both relations (regression check)");
test("'SELECT * FROM users u JOIN Orders o ON u.id = o.user_id WHERE ' → 2 visible relations", () => {
  const sql = "SELECT * FROM users u JOIN Orders o ON u.id = o.user_id WHERE n";
  const ctx = ctxAt(sql);
  assert.equal(ctx.visibleRelations.length, 2, `expected 2 visible relations; got ${ctx.visibleRelations.length}`);
  assert.equal(ctx.kind, "column");
  // 'name' is unambiguous (only in users) → bare
  const { items } = buildCandidates(ctx, deps);
  const nameItem = items.find((i) => i.label === "name");
  assert.ok(nameItem, "name column should be present");
  assert.equal(nameItem!.insertText, "name", `name should be bare; got ${nameItem!.insertText}`);
});

console.log("\n[11] Statement keyword detection still works after a clause boundary");
test("'SELECT * FROM users ' → relation done, next clause keyword expected", () => {
  const sql = "SELECT * FROM users whe";
  const ctx = ctxAt(sql);
  // 'whe' is not a keyword (not in KEYWORDS set) → identifier → column context
  // (this is a prefix for 'where' but tokenizer sees it as identifier).
  assert.equal(ctx.kind, "column", `got ${ctx.kind}`);
  assert.equal(ctx.prefix, "whe");
});

test("'SELECT * FROM users ORDER ' → column context (ORDER is keyword, space after)", () => {
  const sql = "SELECT * FROM users ORDER ";
  const ctx = ctxAt(sql);
  // after ORDER (column-context keyword) + space → column context
  assert.equal(ctx.kind, "column", `got ${ctx.kind}`);
});

// ---- summary --------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
