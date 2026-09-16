// Smoke test for the auto-completion fixes (user-reported issues).
// Pure-logic: imports context-parser + completion-engine; runs under node.
// Bundle + run:
//   npx esbuild tests/smoke.ts --bundle --platform=node --format=esm --outfile=dist-test/smoke.mjs && node dist-test/smoke.mjs
import assert from "node:assert/strict";
import { buildCompletionContext } from "../src/lib/context-parser";
import { buildCandidates } from "../src/lib/completion-engine";
import { assertSqlPayload, assertUtf8ByteLimit, getUtf8ByteLength } from "../src/lib/payload-limits";
import { quoteQualifiedIdentifier } from "../src/lib/sql-identifiers";
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
          makeColumn("StudentID", "text", { ordinal: 4 }),
        ]),
        "public.orders": makeTable("public", "Orders", true, [
          // mixed-case name → must be quoted on insert
          makeColumn("id", "integer", { isPrimaryKey: true, ordinal: 1 }),
          makeColumn("user_id", "integer", { ordinal: 2 }),
          makeColumn("total", "numeric", { ordinal: 3 }),
        ]),
        "public.StakeholderProfile": {
          ...makeTable("public", "StakeholderProfile", true, [
            makeColumn("AcademicSubLevel", "text", { ordinal: 1 }),
          ]),
          key: "public.StakeholderProfile",
        },
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

const duplicateRelationGraph: SchemaGraph = {
  ...graph,
  schemas: {
    BM: {
      name: "BM",
      key: "BM",
      quoted: true,
      relations: {
        "BM.BM_Account": makeTable("BM", "BM_Account", true, [makeColumn("id", "integer")]),
        "BM.FAS_Application": makeTable("BM", "FAS_Application", true, [
          makeColumn("id", "integer"),
          makeColumn("Address", "text"),
          makeColumn("Uin", "text"),
        ]),
        "BM.FAS_StudentSubsidyRescission": makeTable("BM", "FAS_StudentSubsidyRescission", true, [
          makeColumn("id", "integer"),
        ]),
        "BM.BM_StudentSubsidy": makeTable("BM", "BM_StudentSubsidy", true, [
          makeColumn("PaymentPrecentage", "text"),
        ]),
        "BM.BM_AccountBalanceTrans": makeTable("BM", "BM_AccountBalanceTrans", true, [
          makeColumn("Id", "integer"),
        ]),
      },
    },
    BILL: {
      name: "BILL",
      key: "BILL",
      quoted: true,
      relations: {
        "BILL.BM_Account": makeTable("BILL", "BM_Account", true, [makeColumn("id", "integer")]),
      },
    },
  },
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

function ctxAt(sql: string, cursor = sql.length, graphInput = graph) {
  return buildCompletionContext({ sql, cursor, graph: graphInput });
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

test("typing a new 's' before existing SQL suggests SELECT", () => {
  const sql = 's\nSELECT * FROM "BM"."FAS_Application"';
  const ctx = ctxAt(sql, 1);
  assert.equal(ctx.kind, "keyword", `kind should be 'keyword' (got ${ctx.kind})`);
  assert.equal(ctx.prefix, "s");
  const labels = labelsOf(buildCandidates(ctx, deps).items);
  assert.ok(labels.includes("SELECT"), `SELECT should be suggested; got ${labels.slice(0, 10).join(", ")}`);
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

console.log("\n[3] After 'FROM ' (with space) → relation context, quoted tables suggested");
test("'SELECT * FROM ' → relation context, quoted public.users table present", () => {
  const sql = "SELECT * FROM ";
  const ctx = ctxAt(sql);
  assert.equal(ctx.kind, "relation", `kind should be 'relation' (got ${ctx.kind})`);
  const { items } = buildCandidates(ctx, deps);
  const labels = labelsOf(items);
  assert.ok(labels.includes('"public"."users"'), `"public"."users" should be suggested; got ${labels.slice(0, 10).join(", ")}`);
});

test("'SELECT * FROM pub' → schema is a distinct completion item", () => {
  const sql = "SELECT * FROM pub";
  const ctx = ctxAt(sql);
  assert.equal(ctx.kind, "relation", `kind should be 'relation' (got ${ctx.kind})`);
  const { items } = buildCandidates(ctx, deps);
  const schema = items.find((item) => item.label === '"public"');
  assert.ok(schema, `"public" should be suggested; got ${labelsOf(items).slice(0, 10).join(", ")}`);
  assert.equal(schema!.kind, "schema");
  assert.equal(schema!.insertText, '"public".');
});

test('quoted schema completion consumes an existing trailing dot', () => {
  const sql = 'SELECT * FROM "pu".';
  const ctx = ctxAt(sql, sql.length - 2);
  assert.equal(ctx.kind, "relation", `kind should be 'relation' (got ${ctx.kind})`);
  const { items } = buildCandidates(ctx, deps);
  const schema = items.find((item) => item.kind === "schema" && item.label === '"public"');
  assert.ok(schema, `"public" should be suggested; got ${labelsOf(items).slice(0, 10).join(", ")}`);
  const applied = sql.slice(0, ctx.from) + schema!.insertText + sql.slice(ctx.to);
  assert.equal(applied, 'SELECT * FROM "public".');
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

console.log("\n[5] Relation candidates preserve schema qualification and identifier quoting");
test("public.Orders (quoted in DDL) → insertText is '\"public\".\"Orders\"'", () => {
  const sql = "SELECT * FROM ord";
  const ctx = ctxAt(sql);
  assert.equal(ctx.kind, "relation", `kind should be 'relation' (got ${ctx.kind})`);
  const { items } = buildCandidates(ctx, deps);
  const ordersItem = items.find((i) => i.label === '"public"."Orders"');
  assert.ok(ordersItem, `"public"."Orders" should be a candidate; got ${labelsOf(items).slice(0, 10).join(", ")}`);
  assert.equal(ordersItem!.insertText, '"public"."Orders"', `insertText should be "public"."Orders"; got ${ordersItem!.insertText}`);
});

test("lowercase table users (unquoted) → insertText is \"public\".\"users\"", () => {
  const sql = "SELECT * FROM use";
  const ctx = ctxAt(sql);
  assert.equal(ctx.kind, "relation", `kind should be 'relation' (got ${ctx.kind})`);
  const { items } = buildCandidates(ctx, deps);
  const usersItem = items.find((i) => i.label === '"public"."users"');
  assert.ok(usersItem, '"public"."users" should be a candidate');
  assert.equal(usersItem!.insertText, '"public"."users"', `insertText should be "public"."users"; got ${usersItem!.insertText}`);
});

test("relation completion is followed by a space", () => {
  const sql = 'SELECT * FROM "BM"."F"';
  const ctx = ctxAt(sql, sql.length - 1, duplicateRelationGraph);
  const item = buildCandidates(ctx, { ...deps, graph: duplicateRelationGraph }).items.find(
    (candidate) => candidate.label === '"FAS_Application"'
  );
  assert.ok(item, "FAS_Application should be a candidate");
  const applied = sql.slice(0, ctx.from) + `${quoteQualifiedIdentifier(item!.insertText)} ` + sql.slice(ctx.to);
  assert.equal(applied, 'SELECT * FROM "BM"."FAS_Application" ');
});

test("same table name in different schemas stays distinguishable and fully qualified", () => {
  const sql = "SELECT * FROM BM_";
  const ctx = buildCompletionContext({ sql, cursor: sql.length, graph: duplicateRelationGraph });
  const { items } = buildCandidates(ctx, { ...deps, graph: duplicateRelationGraph });
  const accountItems = items.filter((item) => item.insertText.endsWith('"BM_Account"'));
  assert.deepEqual(
    accountItems.map((item) => item.label).sort(),
    ['"BILL"."BM_Account"', '"BM"."BM_Account"'],
  );
  assert.deepEqual(
    accountItems.map((item) => item.insertText).sort(),
    ['"BILL"."BM_Account"', '"BM"."BM_Account"'],
  );
});

test("relation insertion quoting handles unquoted and already quoted qualified identifiers", () => {
  assert.equal(quoteQualifiedIdentifier("BM.BM_Account"), '"BM"."BM_Account"');
  assert.equal(quoteQualifiedIdentifier('"BM"."BM_Account"'), '"BM"."BM_Account"');
  assert.equal(quoteQualifiedIdentifier('"A"."table.with.dot"'), '"A"."table.with.dot"');
});

test("quoted schema prefixes complete only its quoted relation names", () => {
  for (const sql of ['SELECT * FROM "BM".', 'SELECT * FROM "BM". B']) {
    const ctx = ctxAt(sql, sql.length, duplicateRelationGraph);
    assert.equal(ctx.kind, "schema-relation", `${sql}: expected schema-relation; got ${ctx.kind}`);
    assert.equal(ctx.activeSchema, "BM");
    const items = buildCandidates(ctx, { ...deps, graph: duplicateRelationGraph }).items;
    assert.ok(labelsOf(items).includes('"BM_Account"'));
    assert.ok(items.length >= 1, `expected schema-relation candidates; got ${labelsOf(items).slice(0, 10).join(", ")}`);
  }
});

test('schema prefix "Rescission" completes "FAS_StudentSubsidyRescission" without needing FAS_S', () => {
  const sql = 'SELECT * FROM "BM"."Rescission"';
  const ctx = ctxAt(sql, sql.length, duplicateRelationGraph);
  assert.equal(ctx.kind, "schema-relation", `expected schema-relation; got ${ctx.kind}`);
  const items = buildCandidates(ctx, { ...deps, graph: duplicateRelationGraph }).items;
  const item = items.find((i) => i.label === '"FAS_StudentSubsidyRescission"');
  assert.ok(item, `FAS_StudentSubsidyRescission should be suggested; got ${labelsOf(items).slice(0, 10).join(", ")}`);
});

test('schema prefix "F" on quoted relation keeps the closing quote from duplicating', () => {
  const sql = 'SELECT * FROM "BM"."F"';
  const ctx = ctxAt(sql, sql.length - 1, duplicateRelationGraph);
  assert.equal(ctx.kind, "schema-relation", `expected schema-relation; got ${ctx.kind}`);
  const { items } = buildCandidates(ctx, { ...deps, graph: duplicateRelationGraph });
  const item = items.find((i) => i.label === '"FAS_Application"');
  assert.ok(item, `FAS_Application should be suggested; got ${labelsOf(items).slice(0, 10).join(", ")}`);
  const applied = sql.slice(0, ctx.from) + quoteQualifiedIdentifier(item!.insertText) + sql.slice(ctx.to);
  assert.equal(applied, 'SELECT * FROM "BM"."FAS_Application"', `applied SQL should not have a stray trailing quote; got ${applied}`);
});

test('quoted column prefix "P" on BM_StudentSubsidy keeps the closing quote from duplicating', () => {
  const sql = 'SELECT * FROM "BM"."BM_StudentSubsidy" where "P"';
  const ctx = ctxAt(sql, sql.length - 1, duplicateRelationGraph);
  assert.equal(ctx.kind, "column", `expected column; got ${ctx.kind}`);
  const { items } = buildCandidates(ctx, { ...deps, graph: duplicateRelationGraph });
  const item = items.find((i) => i.label === 'PaymentPrecentage');
  assert.ok(item, `PaymentPrecentage should be suggested; got ${labelsOf(items).slice(0, 10).join(", ")}`);
  const applied = sql.slice(0, ctx.from) + item!.insertText + sql.slice(ctx.to);
  assert.equal(applied, 'SELECT * FROM "BM"."BM_StudentSubsidy" where "PaymentPrecentage"', `applied SQL should not have a stray trailing quote; got ${applied}`);
});

test('keyword prefix "wh" after JOIN still suggests WHERE', () => {
  const sql = 'SELECT * FROM "BM"."BM_AccountBalanceTrans" A LEFT JOIN  "BM"."BM_Account" b on A."Id" = b."Id" wh';
  const ctx = ctxAt(sql);
  const { items } = buildCandidates(ctx, { ...deps, graph: duplicateRelationGraph });
  const labels = labelsOf(items);
  assert.ok(labels.includes("WHERE"), `WHERE should be suggested; got ${labels.slice(0, 10).join(", ")}`);
});

test("reserved word 'user' after FROM → relation context (not keyword)", () => {
  // 'user' is a PG reserved word but here it's a table-name prefix.
  const sql = "SELECT * FROM user";
  const ctx = ctxAt(sql);
  assert.equal(ctx.kind, "relation", `typing a reserved word after FROM should be relation context (got ${ctx.kind})`);
  assert.equal(ctx.prefix, "user");
  const { items } = buildCandidates(ctx, deps);
  const labels = labelsOf(items);
  assert.ok(labels.includes('"public"."users"'), `"public"."users" should be suggested for 'user' prefix; got ${labels.slice(0, 10).join(", ")}`);
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
  assert.equal(insertTextOf(items, "id"), '"id"');
});

test("SELECT projection prefixes suggest FAS_Application columns", () => {
  for (const { prefix, column } of [
    { prefix: "u", column: "Uin" },
    { prefix: "a", column: "Address" },
  ]) {
    const sql = `SELECT ${prefix} FROM "BM"."FAS_Application" LIMIT 100;`;
    const ctx = ctxAt(sql, `SELECT ${prefix}`.length, duplicateRelationGraph);
    assert.equal(ctx.kind, "column", `${prefix}: expected column context; got ${ctx.kind}`);
    const item = buildCandidates(ctx, { ...deps, graph: duplicateRelationGraph }).items.find(
      (candidate) => candidate.label === column
    );
    assert.ok(item, `${prefix}: ${column} should be suggested`);
    const applied = sql.slice(0, ctx.from) + item!.insertText + sql.slice(ctx.to);
    assert.equal(applied, `SELECT "${column}" FROM "BM"."FAS_Application" LIMIT 100;`);
  }
});

test("empty SELECT projection includes Uin and Address", () => {
  const sql = 'SELECT  FROM "BM"."FAS_Application" LIMIT 100;';
  const ctx = ctxAt(sql, "SELECT ".length, duplicateRelationGraph);
  assert.equal(ctx.kind, "column", `expected column context; got ${ctx.kind}`);
  const labels = labelsOf(buildCandidates(ctx, { ...deps, graph: duplicateRelationGraph }).items);
  assert.ok(labels.includes("Uin"), `Uin should be suggested; got ${labels.slice(0, 10).join(", ")}`);
  assert.ok(labels.includes("Address"), `Address should be suggested; got ${labels.slice(0, 10).join(", ")}`);
});

test("column substring prefix 'sub' suggests AcademicSubLevel", () => {
  const sql = 'SELECT * FROM "public"."StakeholderProfile" a WHERE sub';
  const ctx = ctxAt(sql);
  assert.equal(ctx.kind, "column", `kind should be 'column' (got ${ctx.kind})`);
  const items = buildCandidates(ctx, deps).items;
  const column = items.find((item) => item.label === "AcademicSubLevel");
  assert.ok(column, `AcademicSubLevel should be suggested; got ${labelsOf(items).slice(0, 10).join(", ")}`);
  assert.equal(column!.insertText, '"AcademicSubLevel"');
});

test("'SELECT name FROM users GROUP BY ' → column context, full column list present", () => {
  const sql = "SELECT name FROM users GROUP BY ";
  const ctx = ctxAt(sql);
  assert.equal(ctx.kind, "column", `kind should be 'column' (got ${ctx.kind})`);
  assert.equal(ctx.prefix, "");
  const { items } = buildCandidates(ctx, deps);
  const labels = labelsOf(items);
  assert.ok(labels.includes("id"), `column 'id' should be present; got ${labels.slice(0, 10).join(", ")}`);
  assert.ok(labels.includes("name"), `column 'name' should be present; got ${labels.slice(0, 10).join(", ")}`);
  assert.ok(labels.includes("email"), `column 'email' should be present; got ${labels.slice(0, 10).join(", ")}`);
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
    idItem!.insertText === 'u."id"' || idItem!.insertText === 'o."id"',
    `ambiguous 'id' insertText should carry alias and quoted column (u."id" or o."id"); got ${idItem!.insertText}`
  );
});

test("unambiguous column 'email' (only in users) → quoted insertText", () => {
  const sql = "SELECT * FROM users u, Orders o WHERE e";
  const ctx = ctxAt(sql);
  const { items } = buildCandidates(ctx, deps);
  const emailItem = items.find((i) => i.label === "email");
  assert.ok(emailItem, "email column should be present");
  assert.equal(emailItem!.insertText, '"email"', `email should be quoted (no alias); got ${emailItem!.insertText}`);
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

test("'a.s' resolves the alias and filters its qualified columns", () => {
  const sql = "SELECT * FROM users a WHERE a.s";
  const ctx = ctxAt(sql);
  assert.equal(ctx.kind, "qualified-column", `kind should be qualified-column; got ${ctx.kind}`);
  assert.equal(ctx.prefix, "s");
  assert.equal(ctx.activeRelation?.name, "users", "alias a should resolve to users");
  const items = buildCandidates(ctx, deps).items;
  assert.ok(labelsOf(items).includes("StudentID"), `StudentID should be suggested; got ${labelsOf(items).join(", ")}`);
  assert.equal(insertTextOf(items, "StudentID"), '"StudentID"');
});

test("quoted alias column prefixes tolerate an unfinished or closed English quote", () => {
  for (const sql of [
    'SELECT * FROM users a WHERE a."Stu',
    'SELECT * FROM users a WHERE a."Stu"',
  ]) {
    const ctx = ctxAt(sql);
    assert.equal(ctx.kind, "qualified-column", `${sql}: expected qualified-column; got ${ctx.kind}`);
    assert.equal(ctx.prefix, "Stu", `${sql}: quoted prefix should exclude quote characters`);
    const items = buildCandidates(ctx, deps).items;
    assert.ok(labelsOf(items).includes("StudentID"), `${sql}: StudentID should be suggested; got ${labelsOf(items).join(", ")}`);
    assert.equal(insertTextOf(items, "StudentID"), '"StudentID"');
  }
});

console.log("\n[10] JOIN clause still parses both relations (regression check)");
test("'SELECT * FROM users u JOIN Orders o ON u.id = o.user_id WHERE ' → 2 visible relations", () => {
  const sql = "SELECT * FROM users u JOIN Orders o ON u.id = o.user_id WHERE n";
  const ctx = ctxAt(sql);
  assert.equal(ctx.visibleRelations.length, 2, `expected 2 visible relations; got ${ctx.visibleRelations.length}`);
  assert.equal(ctx.kind, "column");
  // 'name' is unambiguous (only in users) → quoted without an alias
  const { items } = buildCandidates(ctx, deps);
  const nameItem = items.find((i) => i.label === "name");
  assert.ok(nameItem, "name column should be present");
  assert.equal(nameItem!.insertText, '"name"', `name should be quoted; got ${nameItem!.insertText}`);
});

console.log("\n[11] Statement keyword detection still works after a clause boundary");
test("'SELECT * FROM users whe' → keyword context suggests WHERE", () => {
  const sql = "SELECT * FROM users whe";
  const ctx = ctxAt(sql);
  assert.equal(ctx.kind, "keyword", `got ${ctx.kind}`);
  assert.equal(ctx.prefix, "whe");
  const labels = labelsOf(buildCandidates(ctx, deps).items);
  assert.ok(labels.includes("WHERE"), `WHERE should be suggested; got ${labels.slice(0, 10).join(", ")}`);
});

test("'SELECT * FROM users ORDER ' → column context (ORDER is keyword, space after)", () => {
  const sql = "SELECT * FROM users ORDER ";
  const ctx = ctxAt(sql);
  // after ORDER (column-context keyword) + space → column context
  assert.equal(ctx.kind, "column", `got ${ctx.kind}`);
});

test("completing on BY replaces the entire GROUP BY or ORDER BY phrase", () => {
  for (const { sql, keyword } of [
    { sql: "SELECT * FROM users GROUP BY", keyword: "GROUP BY" },
    { sql: "SELECT * FROM users ORDER BY", keyword: "ORDER BY" },
  ]) {
    const cursor = sql.lastIndexOf("BY") + 1;
    const ctx = ctxAt(sql, cursor);
    assert.equal(ctx.kind, "keyword", `${sql}: expected keyword context; got ${ctx.kind}`);
    const item = buildCandidates(ctx, deps).items.find((candidate) => candidate.label === keyword);
    assert.ok(item, `${sql}: ${keyword} should be suggested`);
    const completed = `${sql.slice(0, ctx.from)}${item!.insertText}${sql.slice(ctx.to)}`;
    assert.equal(completed, `${sql.slice(0, sql.lastIndexOf(keyword))}${item!.insertText}`);
  }
});

test("retyping G before an existing ORDER BY suggests GROUP BY", () => {
  const sql = 'SELECT * FROM "public"."users" WHERE "id" = 1  G ORDER BY "id" DESC';
  const cursor = sql.indexOf(" G ORDER") + 2;
  const ctx = ctxAt(sql, cursor);
  assert.equal(ctx.kind, "keyword", `expected keyword context; got ${ctx.kind}`);
  assert.equal(ctx.prefix, "G");
  const { items } = buildCandidates(ctx, deps);
  const labels = labelsOf(items);
  assert.ok(labels.includes("GROUP BY"), `GROUP BY should be suggested; got ${labels.slice(0, 10).join(", ")}`);
});

test("completed SQL clauses provide their next keyword", () => {
  const cases = [
    { sql: "SELECT id f", keyword: "FROM" },
    { sql: "SELECT * FROM users j", keyword: "JOIN" },
    { sql: "SELECT * FROM users JOIN Orders o", keyword: "ON" },
    { sql: "SELECT * FROM users WHERE id = 1 g", keyword: "GROUP BY" },
    { sql: "SELECT * FROM users GROUP BY id h", keyword: "HAVING" },
    { sql: "SELECT * FROM users ORDER BY id l", keyword: "LIMIT" },
  ];

  for (const { sql, keyword } of cases) {
    const ctx = ctxAt(sql);
    assert.equal(ctx.kind, "keyword", `${sql}: expected keyword context; got ${ctx.kind}`);
    const labels = labelsOf(buildCandidates(ctx, deps).items);
    assert.ok(labels.includes(keyword), `${sql}: ${keyword} should be suggested; got ${labels.slice(0, 10).join(", ")}`);
  }
});

test("completed GROUP BY item followed by 'h' suggests HAVING, not columns", () => {
  const sql = 'SELECT * FROM "public"."users" GROUP BY "id","id" h';
  const ctx = ctxAt(sql);
  assert.equal(ctx.kind, "keyword", `expected keyword context; got ${ctx.kind}`);
  assert.equal(ctx.prefix, "h");
  const { items } = buildCandidates(ctx, deps);
  const labels = labelsOf(items);
  assert.ok(labels.includes("HAVING"), `HAVING should be suggested; got ${labels.slice(0, 10).join(", ")}`);
  assert.ok(items.every((item) => item.kind === "keyword"), `columns should not be suggested after a completed GROUP BY expression; got ${items.map((item) => item.kind).join(", ")}`);
});

test("predicate value followed by 'o' suggests ORDER BY and OR, not columns", () => {
  const sql = 'SELECT * FROM "public"."users" WHERE "id" = 1 o';
  const ctx = ctxAt(sql);
  assert.equal(ctx.kind, "keyword", `expected keyword context; got ${ctx.kind}`);
  assert.equal(ctx.prefix, "o");
  const { items } = buildCandidates(ctx, deps);
  const labels = labelsOf(items);
  assert.ok(labels.includes("OR"), `OR should be suggested; got ${labels.slice(0, 10).join(", ")}`);
  assert.ok(labels.includes("ORDER BY"), `ORDER BY should be suggested; got ${labels.slice(0, 10).join(", ")}`);
  assert.ok(!labels.includes("id"), `columns should not be suggested after a completed predicate; got ${labels.slice(0, 10).join(", ")}`);
});

test("quoted JOIN predicate followed by 'w' suggests WHERE", () => {
  const sql = [
    'SELECT * FROM "public"."StakeholderProfile" a',
    'LEFT JOIN "public"."Relationship_Family" b ON "Uin" = "PrimaryUin"',
    "w",
  ].join("\n");
  const ctx = ctxAt(sql);
  const labels = labelsOf(buildCandidates(ctx, deps).items);
  assert.ok(labels.includes("WHERE"), `WHERE should be suggested; got ${labels.slice(0, 10).join(", ")}`);
});

console.log("\n[12] Payload guards bound local parsing work");
test("UTF-8 byte limits account for multibyte DDL content", () => {
  assert.equal(getUtf8ByteLength("A中"), 4);
  assert.doesNotThrow(() => assertUtf8ByteLimit("A中", 4, "DDL import"));
  assert.throws(() => assertUtf8ByteLimit("A中", 3, "DDL import"), /exceeds/);
});

test("SQL payload guard rejects oversized documents", () => {
  assert.throws(() => assertSqlPayload("x".repeat(1_500_001)), /exceeds/);
});

test("SQL payload guard rejects cursors outside the document", () => {
  assert.throws(() => assertSqlPayload("SELECT 1", 9), /cursor/);
  assert.doesNotThrow(() => assertSqlPayload("SELECT 1", 8));
});

// ---- summary --------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
