/**
 * pgport core: connection-string parsing, a read-only SQL guard, an
 * executor-backed query class, a `psql` subprocess executor, and schema
 * listing grouped from information_schema rows.
 *
 * No database driver is bundled. The default executor runs the query
 * through the `psql` command-line client inside an explicit
 * READ ONLY transaction, mirroring the reference server's approach of
 * never letting a write reach the database. When `psql` is missing or
 * no connection is configured, queries fail with a plain error that
 * says so — pgport never invents rows.
 */
import { execFile } from "node:child_process";
import type { PgConnectionInfo, QueryExecutor, TableColumns } from "./types.js";

export const VERSION = "0.1.0";

export const NO_EXECUTOR_MESSAGE =
  "No database connection configured: pgport has no query executor. " +
  "Pass a postgres:// connection string to `pgport mcp`, or set " +
  "PGPORT_DATABASE_URL / DATABASE_URL.";

// ---------------------------------------------------------------------------
// Connection-string parsing
// ---------------------------------------------------------------------------

export function parseConnectionString(connectionString: string): PgConnectionInfo {
  const raw = typeof connectionString === "string" ? connectionString.trim() : "";
  if (!raw) {
    throw new Error("Invalid connection string: '' (expected a postgres:// or postgresql:// URL)");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid connection string: '${connectionString}' (could not be parsed as a URL)`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(
      `Invalid connection string: '${connectionString}' (scheme must be postgres:// or postgresql://)`,
    );
  }
  const host = url.hostname;
  if (!host) {
    throw new Error(`Invalid connection string: '${connectionString}' (missing host)`);
  }
  let port = 5432;
  if (url.port) {
    port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid connection string: '${connectionString}' (invalid port '${url.port}')`);
    }
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) {
    throw new Error(`Invalid connection string: '${connectionString}' (missing database name)`);
  }
  const info: PgConnectionInfo = { host, port, database };
  if (url.username) info.user = decodeURIComponent(url.username);
  return info;
}

/** Explicit argument wins, then PGPORT_DATABASE_URL, then DATABASE_URL. */
export function resolveConnectionString(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromArg = explicit?.trim();
  if (fromArg) return fromArg;
  const fromPgport = env.PGPORT_DATABASE_URL?.trim();
  if (fromPgport) return fromPgport;
  const fromGeneric = env.DATABASE_URL?.trim();
  if (fromGeneric) return fromGeneric;
  return undefined;
}

// ---------------------------------------------------------------------------
// Read-only guard
//
// Approach: work on two views of the input.
//  - `stripped` has single-quoted string literals blanked out and both
//    comment styles removed, so keyword and semicolon scanning never
//    sees text that lives inside a literal (SELECT 'delete me' is fine).
//  - The first keyword is read from `stripped` after leading whitespace
//    and comments are gone, which is the same view.
// Rules, in order: the input must be non-empty; it must be a single
// statement (a semicolon in `stripped` followed by any non-whitespace
// means a second statement); its first keyword must be SELECT or WITH;
// and none of the forbidden whole words may appear anywhere in
// `stripped`. The forbidden-word scan is deliberately blunt — a column
// genuinely named `update` will be rejected — because a guard that can
// be talked around is worse than one that occasionally says no.
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "CREATE",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "COPY",
  "VACUUM",
] as const;

const FORBIDDEN_RE = new RegExp(`\\b(${FORBIDDEN_KEYWORDS.join("|")})\\b`, "i");

/**
 * Replace single-quoted literals with a placeholder and drop comments.
 * Handles '' as an escaped quote inside a literal. Double-quoted
 * identifiers are left alone: they name objects, not data, and a
 * forbidden word inside one is still caught — conservative on purpose.
 */
export function stripLiteralsAndComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1] ?? "";
    if (ch === "'") {
      out += "''";
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      out += " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function assertReadOnly(sql: string): void {
  if (typeof sql !== "string" || !sql.trim()) {
    throw new Error("SQL query is empty: a single SELECT or WITH statement is required");
  }
  const stripped = stripLiteralsAndComments(sql);
  if (!stripped.trim()) {
    throw new Error("SQL query is empty: a single SELECT or WITH statement is required");
  }
  // Single statement only: a semicolon with anything real after it
  // starts a second statement. One trailing semicolon is fine.
  const semi = stripped.indexOf(";");
  if (semi !== -1 && stripped.slice(semi + 1).trim().length > 0) {
    throw new Error("Multiple SQL statements are not allowed: submit one SELECT or WITH statement");
  }
  const firstMatch = /^\s*([A-Za-z]+)/.exec(stripped);
  const first = firstMatch ? firstMatch[1].toUpperCase() : "";
  if (first !== "SELECT" && first !== "WITH") {
    throw new Error(
      `Only read-only SELECT or WITH queries are allowed (got ${first ? `'${first}'` : "no leading keyword"})`,
    );
  }
  const forbidden = FORBIDDEN_RE.exec(stripped);
  if (forbidden) {
    throw new Error(`Query rejected: the keyword ${forbidden[1].toUpperCase()} is not allowed in a read-only query`);
  }
}

// ---------------------------------------------------------------------------
// CSV parsing for psql --csv output
// ---------------------------------------------------------------------------

/**
 * Parse CSV text (header row plus data rows) into row objects keyed by
 * the header names. Handles quoted fields, embedded commas, doubled
 * quotes, and embedded newlines inside quotes — the shapes `psql --csv`
 * actually produces. All values stay strings, as psql renders them.
 */
export function parseCsvRows(text: string): Array<Record<string, unknown>> {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;
  const pushField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const pushRow = () => {
    pushField();
    records.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      continue;
    }
    if (ch === ",") {
      pushField();
      continue;
    }
    if (ch === "\n") {
      pushRow();
      continue;
    }
    if (ch === "\r") continue;
    field += ch;
    fieldStarted = true;
  }
  if (fieldStarted || field.length > 0 || row.length > 0) pushRow();
  // Drop fully-empty trailing records produced by a final newline.
  while (
    records.length > 0 &&
    records[records.length - 1].length === 1 &&
    records[records.length - 1][0] === ""
  ) {
    records.pop();
  }
  if (records.length === 0) return [];
  const headers = records[0];
  return records.slice(1).map((cells) => {
    const obj: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      obj[h] = cells[idx] ?? "";
    });
    return obj;
  });
}

// ---------------------------------------------------------------------------
// psql executor
// ---------------------------------------------------------------------------

/**
 * Default executor: runs the statement through the `psql` binary.
 * The SQL is wrapped in an explicit read-only transaction exactly as
 * specified for this rebuild, and `--csv` output is parsed into rows.
 * `psql` also echoes the transaction tags (`BEGIN` / `COMMIT`) around
 * the CSV block; those two lines are removed before parsing.
 */
export class PsqlExecutor implements QueryExecutor {
  constructor(private readonly connectionString: string) {
    // Validate eagerly so a malformed string fails at wiring time,
    // but never open a connection here — the server must start and
    // answer tools/list with no live database behind it.
    parseConnectionString(connectionString);
  }

  async runQuery(sql: string): Promise<Array<Record<string, unknown>>> {
    const wrapped = `BEGIN TRANSACTION READ ONLY; ${sql}; COMMIT;`;
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "psql",
        [this.connectionString, "-v", "ON_ERROR_STOP=1", "--csv", "-c", wrapped],
        { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
        (err, out, stderr) => {
          if (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "ENOENT") {
              reject(
                new Error(
                  "psql executable not found: the `psql` command-line client is not installed " +
                    "or not on PATH, so pgport cannot run the query. Install PostgreSQL client " +
                    "tools and retry. (spawn psql ENOENT)",
                ),
              );
              return;
            }
            const detail = (stderr || "").trim() || err.message;
            reject(new Error(`psql query failed: ${detail}`));
            return;
          }
          resolve(out);
        },
      );
    });
    const lines = stdout.split("\n");
    if (lines.length > 0 && lines[0].trim() === "BEGIN") lines.shift();
    if (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length > 0 && lines[lines.length - 1].trim() === "COMMIT") lines.pop();
    const csvText = lines.join("\n");
    if (!csvText.trim()) return [];
    return parseCsvRows(csvText);
  }
}

export function createPsqlExecutor(connectionString: string): QueryExecutor {
  return new PsqlExecutor(connectionString);
}

// ---------------------------------------------------------------------------
// Core class
// ---------------------------------------------------------------------------

export class PgPort {
  constructor(private readonly executor?: QueryExecutor | null) {}

  async query(sql: string): Promise<Array<Record<string, unknown>>> {
    assertReadOnly(sql);
    if (!this.executor) {
      throw new Error(NO_EXECUTOR_MESSAGE);
    }
    return this.executor.runQuery(sql);
  }

  async listSchemas(): Promise<TableColumns[]> {
    if (!this.executor) {
      throw new Error(NO_EXECUTOR_MESSAGE);
    }
    return listSchemas(this.executor);
  }
}

// ---------------------------------------------------------------------------
// Schema listing
// ---------------------------------------------------------------------------

export const SCHEMA_QUERY =
  "SELECT table_schema, table_name, column_name " +
  "FROM information_schema.columns " +
  "ORDER BY table_schema, table_name, ordinal_position";

/**
 * Group information_schema column rows into one entry per table.
 * Row keys are read tolerantly (table_schema/schema, table_name/table)
 * so recorded fixtures and live rows group the same way.
 */
export async function listSchemas(executor: QueryExecutor): Promise<TableColumns[]> {
  const rows = await executor.runQuery(SCHEMA_QUERY);
  const byKey = new Map<string, TableColumns>();
  for (const row of rows) {
    const schema = String(row.table_schema ?? row.schema ?? "public");
    const table = String(row.table_name ?? row.table ?? "");
    if (!table) continue;
    const column = String(row.column_name ?? row.column ?? "");
    if (!column) continue;
    const key = `${schema}.${table}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { schema, table, columns: [] };
      byKey.set(key, entry);
    }
    if (!entry.columns.includes(column)) entry.columns.push(column);
  }
  return [...byKey.values()];
}

/**
 * Wire a PgPort from an optional connection string: a configured string
 * yields the psql executor; no string yields a port whose queries fail
 * with NO_EXECUTOR_MESSAGE while tools/list still works.
 */
export function createPgPort(connectionString?: string): PgPort {
  const resolved = resolveConnectionString(connectionString);
  if (!resolved) return new PgPort(null);
  return new PgPort(createPsqlExecutor(resolved));
}
