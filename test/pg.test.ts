import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertReadOnly,
  listSchemas,
  parseConnectionString,
  parseCsvRows,
  PgPort,
  SCHEMA_QUERY,
} from "../src/pg.js";
import type { QueryExecutor } from "../src/types.js";

function fakeExecutor(rows: Array<Record<string, unknown>>): QueryExecutor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async runQuery(sql: string) {
      calls.push(sql);
      return rows;
    },
  };
}

describe("parseConnectionString", () => {
  it("parses a full postgres:// URL", () => {
    const info = parseConnectionString("postgres://alice:s3cret@db.example.com:6543/shop");
    assert.equal(info.host, "db.example.com");
    assert.equal(info.port, 6543);
    assert.equal(info.database, "shop");
    assert.equal(info.user, "alice");
  });

  it("applies defaults: port 5432 and no user", () => {
    const info = parseConnectionString("postgres://localhost/mydb");
    assert.equal(info.host, "localhost");
    assert.equal(info.port, 5432);
    assert.equal(info.database, "mydb");
    assert.equal(info.user, undefined);
  });

  it("accepts the postgresql:// scheme", () => {
    const info = parseConnectionString("postgresql://bob@db.internal:5433/analytics");
    assert.equal(info.host, "db.internal");
    assert.equal(info.port, 5433);
    assert.equal(info.database, "analytics");
    assert.equal(info.user, "bob");
  });

  it("rejects malformed connection strings", () => {
    for (const bad of [
      "",
      "not a url",
      "http://localhost/mydb",
      "mysql://localhost/mydb",
      "postgres://",
      "postgres://localhost",
      "postgres://localhost/",
    ]) {
      assert.throws(() => parseConnectionString(bad), /Invalid connection string/, bad);
    }
  });
});

describe("assertReadOnly guard", () => {
  it("accepts a plain SELECT", () => {
    assert.doesNotThrow(() => assertReadOnly("SELECT * FROM users WHERE id = 1"));
    assert.doesNotThrow(() => assertReadOnly("  select id, name from users;"));
  });

  it("accepts a WITH ... SELECT", () => {
    assert.doesNotThrow(() =>
      assertReadOnly("WITH recent AS (SELECT * FROM orders LIMIT 5) SELECT * FROM recent"),
    );
  });

  it("accepts a SELECT after leading comments", () => {
    assert.doesNotThrow(() => assertReadOnly("-- report query\n/* block */ SELECT 1"));
  });

  it("rejects INSERT", () => {
    assert.throws(() => assertReadOnly("INSERT INTO users (name) VALUES ('x')"), /not allowed|Only read-only/);
  });

  it("rejects UPDATE", () => {
    assert.throws(() => assertReadOnly("UPDATE users SET name = 'x'"), /not allowed|Only read-only/);
  });

  it("rejects DELETE", () => {
    assert.throws(() => assertReadOnly("DELETE FROM users WHERE id = 1"), /not allowed|Only read-only/);
  });

  it("rejects DROP", () => {
    assert.throws(() => assertReadOnly("DROP TABLE users"), /not allowed|Only read-only/);
  });

  it("rejects a write keyword hidden behind WITH", () => {
    assert.throws(
      () => assertReadOnly("WITH x AS (DELETE FROM users RETURNING id) SELECT * FROM x"),
      /not allowed/,
    );
  });

  it("rejects multiple statements", () => {
    assert.throws(() => assertReadOnly("SELECT 1; SELECT 2"), /Multiple SQL statements/);
    assert.throws(() => assertReadOnly("SELECT 1; DROP TABLE users"), /Multiple SQL statements/);
  });

  it("rejects empty input", () => {
    assert.throws(() => assertReadOnly(""), /empty/);
    assert.throws(() => assertReadOnly("   \n  "), /empty/);
    assert.throws(() => assertReadOnly("-- only a comment"), /empty|Only read-only/);
  });

  it("does not false-positive on a keyword inside a string literal", () => {
    assert.doesNotThrow(() => assertReadOnly("SELECT 'delete me'"));
    assert.doesNotThrow(() => assertReadOnly("SELECT * FROM notes WHERE body = 'drop table users; delete'"));
    assert.doesNotThrow(() => assertReadOnly("SELECT 'it''s an update'"));
  });
});

describe("PgPort.query", () => {
  it("passes SQL through the fake executor and returns its rows", async () => {
    const rows = [
      { id: "1", name: "Ada" },
      { id: "2", name: "Grace" },
    ];
    const executor = fakeExecutor(rows);
    const port = new PgPort(executor);
    const out = await port.query("SELECT id, name FROM users ORDER BY id");
    assert.deepEqual(out, rows);
    assert.deepEqual(executor.calls, ["SELECT id, name FROM users ORDER BY id"]);
  });

  it("guards before the executor is ever called", async () => {
    const executor = fakeExecutor([]);
    const port = new PgPort(executor);
    await assert.rejects(() => port.query("DELETE FROM users"), /not allowed|Only read-only/);
    assert.deepEqual(executor.calls, []);
  });

  it("propagates executor errors", async () => {
    const failing: QueryExecutor = {
      async runQuery() {
        throw new Error("connection to server at db.example.com failed: Connection refused");
      },
    };
    const port = new PgPort(failing);
    await assert.rejects(() => port.query("SELECT 1"), /Connection refused/);
  });

  it("errors clearly when no executor is configured", async () => {
    const port = new PgPort();
    await assert.rejects(() => port.query("SELECT 1"), /No database connection configured/);
    const nullPort = new PgPort(null);
    await assert.rejects(() => nullPort.query("SELECT 1"), /No database connection configured/);
  });
});

describe("listSchemas", () => {
  it("groups information_schema rows into per-table column lists", async () => {
    const executor = fakeExecutor([
      { table_schema: "public", table_name: "users", column_name: "id" },
      { table_schema: "public", table_name: "users", column_name: "name" },
      { table_schema: "public", table_name: "users", column_name: "email" },
      { table_schema: "public", table_name: "orders", column_name: "id" },
      { table_schema: "public", table_name: "orders", column_name: "user_id" },
      { table_schema: "audit", table_name: "events", column_name: "payload" },
    ]);
    const schemas = await listSchemas(executor);
    assert.deepEqual(schemas, [
      { schema: "public", table: "users", columns: ["id", "name", "email"] },
      { schema: "public", table: "orders", columns: ["id", "user_id"] },
      { schema: "audit", table: "events", columns: ["payload"] },
    ]);
    assert.deepEqual(executor.calls, [SCHEMA_QUERY]);
    assert.match(SCHEMA_QUERY, /information_schema\.columns/);
  });

  it("is also available as a PgPort method", async () => {
    const executor = fakeExecutor([
      { table_schema: "public", table_name: "t", column_name: "c1" },
    ]);
    const port = new PgPort(executor);
    assert.deepEqual(await port.listSchemas(), [
      { schema: "public", table: "t", columns: ["c1"] },
    ]);
  });

  it("errors clearly with no executor", async () => {
    const port = new PgPort(null);
    await assert.rejects(() => port.listSchemas(), /No database connection configured/);
  });
});

describe("parseCsvRows", () => {
  it("parses psql-style CSV into row objects", () => {
    const rows = parseCsvRows('id,name,note\n1,Ada,"hello, world"\n2,Grace,"said ""hi"""\n');
    assert.deepEqual(rows, [
      { id: "1", name: "Ada", note: "hello, world" },
      { id: "2", name: "Grace", note: 'said "hi"' },
    ]);
  });

  it("returns no rows for header-only or empty output", () => {
    assert.deepEqual(parseCsvRows("id,name\n"), []);
    assert.deepEqual(parseCsvRows(""), []);
  });
});
