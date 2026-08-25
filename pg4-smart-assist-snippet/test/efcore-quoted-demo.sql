-- ============================================================
-- EF Core 风格全引号 demo 数据库（public schema = EF Core 默认）
-- 用途：pg4 Smart Assist 引号感知补全验证
-- 特点：
--   1. 所有标识符均带双引号、PascalCase 大小写保留（EF Core 默认命名）
--   2. 含保留字表名 "Order"（未引号写 ORDER 会语法错误）
--   3. 含前导下划线表 "__EFMigrationsHistory"（EF Core 迁移历史表）
--   4. 含 ASP.NET Identity 三件套 + 电商域模型 + 样例数据
-- 执行方式：pgAdmin Query Tool 直接 Execute（可重复执行，先 DROP 再 CREATE）
-- 快照导入：importSnapshotFromText(全文, 'efcore-demo', 'efcore-quoted-demo.sql')
--   解析器只取 CREATE TABLE 语句，DROP/INSERT 自动忽略
-- ============================================================

-- ---------- 重置（可重复执行） ----------
DROP TABLE IF EXISTS "OrderItem" CASCADE;
DROP TABLE IF EXISTS "Order" CASCADE;
DROP TABLE IF EXISTS "Customer" CASCADE;
DROP TABLE IF EXISTS "Product" CASCADE;
DROP TABLE IF EXISTS "Category" CASCADE;
DROP TABLE IF EXISTS "AspNetUserRoles" CASCADE;
DROP TABLE IF EXISTS "AspNetRoles" CASCADE;
DROP TABLE IF EXISTS "AspNetUsers" CASCADE;
DROP TABLE IF EXISTS "__EFMigrationsHistory" CASCADE;

-- ---------- ASP.NET Identity 三件套 ----------
CREATE TABLE "AspNetUsers" (
    "Id" text PRIMARY KEY,
    "UserName" text NOT NULL,
    "NormalizedUserName" text,
    "Email" text,
    "PasswordHash" text,
    "CreatedAtUtc" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "AspNetRoles" (
    "Id" text PRIMARY KEY,
    "Name" text NOT NULL,
    "NormalizedName" text
);

CREATE TABLE "AspNetUserRoles" (
    "UserId" text NOT NULL REFERENCES "AspNetUsers" ("Id"),
    "RoleId" text NOT NULL REFERENCES "AspNetRoles" ("Id"),
    PRIMARY KEY ("UserId", "RoleId")
);

-- ---------- 电商域模型 ----------
CREATE TABLE "Category" (
    "CategoryId" serial PRIMARY KEY,
    "CategoryName" text NOT NULL,
    "Description" text
);

CREATE TABLE "Product" (
    "ProductId" serial PRIMARY KEY,
    "ProductName" text NOT NULL,
    "CategoryId" integer NOT NULL REFERENCES "Category" ("CategoryId"),
    "UnitPrice" numeric(10, 2) NOT NULL,
    "UnitsInStock" integer NOT NULL DEFAULT 0,
    "Discontinued" boolean NOT NULL DEFAULT false
);

CREATE TABLE "Customer" (
    "CustomerId" serial PRIMARY KEY,
    "CompanyName" text NOT NULL,
    "ContactName" text,
    "Email" text,
    "RegisteredAtUtc" timestamptz NOT NULL DEFAULT now()
);

-- 保留字表名：未引号 ORDER 是 SQL 保留字，必须 "Order"
CREATE TABLE "Order" (
    "OrderId" serial PRIMARY KEY,
    "CustomerId" integer NOT NULL REFERENCES "Customer" ("CustomerId"),
    "OrderDate" timestamptz NOT NULL DEFAULT now(),
    "ShippedDate" timestamptz,
    "OrderStatus" text NOT NULL DEFAULT 'Pending'
);

CREATE TABLE "OrderItem" (
    "OrderItemId" serial PRIMARY KEY,
    "OrderId" integer NOT NULL REFERENCES "Order" ("OrderId"),
    "ProductId" integer NOT NULL REFERENCES "Product" ("ProductId"),
    "Quantity" integer NOT NULL,
    "UnitPrice" numeric(10, 2) NOT NULL
);

-- EF Core 迁移历史表（前导双下划线）
CREATE TABLE "__EFMigrationsHistory" (
    "MigrationId" text PRIMARY KEY,
    "ProductVersion" text NOT NULL
);

-- ---------- 样例数据 ----------
INSERT INTO "AspNetRoles" ("Id", "Name", "NormalizedName") VALUES
    ('role-admin', 'Administrator', 'ADMINISTRATOR'),
    ('role-user', 'User', 'USER');

INSERT INTO "AspNetUsers" ("Id", "UserName", "NormalizedUserName", "Email") VALUES
    ('user-001', 'alice', 'ALICE', 'alice@example.com'),
    ('user-002', 'bob', 'BOB', 'bob@example.com');

INSERT INTO "AspNetUserRoles" ("UserId", "RoleId") VALUES
    ('user-001', 'role-admin'),
    ('user-002', 'role-user');

INSERT INTO "Category" ("CategoryName", "Description") VALUES
    ('Beverages', 'Soft drinks, coffees, teas, beers'),
    ('Condiments', 'Sweet and savory sauces'),
    ('Electronics', 'Consumer electronics');

INSERT INTO "Product" ("ProductName", "CategoryId", "UnitPrice", "UnitsInStock") VALUES
    ('Chai', 1, 18.00, 39),
    ('Coffee', 1, 46.00, 17),
    ('Aniseed Syrup', 2, 10.00, 13),
    ('USB-C Cable', 3, 9.99, 120);

INSERT INTO "Customer" ("CompanyName", "ContactName", "Email") VALUES
    ('Alfreds Futterkiste', 'Maria Anders', 'maria@example.com'),
    ('Contoso Ltd', 'Peter Wilson', 'peter@contoso.com');

INSERT INTO "Order" ("CustomerId", "OrderStatus") VALUES
    (1, 'Shipped'),
    (2, 'Pending');

INSERT INTO "OrderItem" ("OrderId", "ProductId", "Quantity", "UnitPrice") VALUES
    (1, 1, 3, 18.00),
    (1, 4, 2, 9.99),
    (2, 2, 1, 46.00);

INSERT INTO "__EFMigrationsHistory" ("MigrationId", "ProductVersion") VALUES
    ('20260823000001_InitialCreate', '9.0.0');
