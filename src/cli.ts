#!/usr/bin/env node
/**
 * pgport CLI.
 *
 *   pgport mcp [connection-string]
 *   pgport query <connection-string> <sql>
 *   pgport schemas <connection-string>
 *   pgport --version
 *
 * Exit codes: 0 success, 1 query/connection error, 2 usage error.
 * For `mcp`, the connection string may be omitted when
 * PGPORT_DATABASE_URL or DATABASE_URL is set; the server still starts
 * and lists its tool without one, and only queries fail.
 */
import { PgPort, PsqlExecutor, VERSION } from "./pg.js";

function usage(): never {
  console.error(`Usage:
  pgport mcp [connection-string]
  pgport query <connection-string> <sql>
  pgport schemas <connection-string>
  pgport --version`);
  process.exit(2);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    await import("./mcp.js");
    return;
  }
  if (!cmd) usage();
  try {
    if (cmd === "query") {
      const [connectionString, ...sqlParts] = rest;
      if (!connectionString || sqlParts.length === 0) usage();
      const sql = sqlParts.join(" ");
      const port = new PgPort(new PsqlExecutor(connectionString));
      const rows = await port.query(sql);
      console.log(JSON.stringify(rows, null, 2));
    } else if (cmd === "schemas") {
      const [connectionString] = rest;
      if (!connectionString) usage();
      const port = new PgPort(new PsqlExecutor(connectionString));
      const schemas = await port.listSchemas();
      console.log(JSON.stringify(schemas, null, 2));
    } else {
      usage();
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
