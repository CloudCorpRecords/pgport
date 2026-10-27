# Changelog

## 0.1.0 (2026-10-26)

- Initial release.
- CLI: `pgport query <connection-string> <sql>` runs a single read-only
  query and prints rows as JSON; `pgport schemas <connection-string>`
  lists tables and their columns; `pgport mcp [connection-string]`
  starts the stdio MCP server. Connection strings can also come from
  `PGPORT_DATABASE_URL` or `DATABASE_URL`.
- MCP server with one tool: `query`, taking a required `sql` string.
- Read-only guard: only a single statement whose first keyword is
  `SELECT` or `WITH` is accepted; write and DDL keywords are rejected
  outside string literals, and multi-statement input is rejected.
- Queries run through the `psql` subprocess inside a
  `BEGIN TRANSACTION READ ONLY` block; no database driver is bundled.
- Schema listing groups `information_schema` rows into per-table
  column lists, exposed through the CLI `schemas` command.
