# pgport

pgport lets an agent — or you, at a terminal — ask a PostgreSQL
database questions without ever being able to change it. It accepts a
connection string, runs a single read-only query, and hands back the
rows. Anything that is not one plain `SELECT` or `WITH ... SELECT`
statement is refused before it leaves the process, and the statement
that does run executes inside an explicit read-only transaction.

There is no bundled database driver. Under the hood pgport shells out
to the `psql` command-line client, so a machine that wants live answers
needs `psql` on its `PATH`. Without it — or without a connection
string — the server still starts and lists its tool; only the query
itself reports the problem.

## Install

```bash
npx @reneturcios/pgport query postgres://user@localhost:5432/mydb "SELECT 1"
```

Or run the container image:

```bash
docker run -i ghcr.io/cloudcorprecords/pgport
```

The container defaults to the MCP server (see below). Pass CLI
arguments to use it as a CLI instead.

## CLI

```bash
# Run one read-only query; rows print as JSON
pgport query postgres://alice@localhost/shop "SELECT id, name FROM products ORDER BY id"

# See what tables exist and which columns each one has
pgport schemas postgres://alice@localhost/shop

# Start the MCP server (connection string optional, see below)
pgport mcp postgres://alice@localhost/shop

pgport --version
```

Exit codes: `0` on success, `1` when the query, the connection string,
or `psql` itself fails (the error says which), `2` for usage errors.

The connection string is a normal PostgreSQL URL:
`postgres://` or `postgresql://`, with host, optional port (default
5432), database name from the path, and optional user and password in
the userinfo. For the `mcp` command the string can be left off the
command line and supplied through the `PGPORT_DATABASE_URL`
environment variable instead (plain `DATABASE_URL` works too).

## The read-only guard

A query is accepted only if all of these hold:

- After leading whitespace and comments are stripped, its first
  keyword is `SELECT` or `WITH`.
- It is a single statement: a semicolon followed by anything other
  than whitespace ends the conversation.
- None of `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`,
  `TRUNCATE`, `GRANT`, `REVOKE`, `COPY`, or `VACUUM` appears as a
  whole word outside a string literal. Single-quoted literals are
  blanked out before scanning, so `SELECT 'delete me'` is a perfectly
  good query; a column literally named `update` is not — the guard
  would rather refuse an odd name than be talked around.

Accepted queries run as
`BEGIN TRANSACTION READ ONLY; <sql>; COMMIT;` through
`psql -v ON_ERROR_STOP=1 --csv`, and the CSV output is parsed into row
objects. Values come back as the strings psql rendered.

## MCP server

One bin serves both faces. The `mcp` subcommand starts a stdio MCP
server:

```bash
npx -y @reneturcios/pgport mcp postgres://alice@localhost/shop
```

MCP client configuration:

```json
{
  "mcpServers": {
    "pgport": {
      "command": "npx",
      "args": ["-y", "@reneturcios/pgport", "mcp"],
      "env": { "PGPORT_DATABASE_URL": "postgres://alice@localhost/shop" }
    }
  }
}
```

### Tools

| Tool | Input | What it returns |
| --- | --- | --- |
| `query` | `sql` (string, required) — one read-only SQL statement | The result rows as a JSON array of objects keyed by column name. Guard violations, a missing connection, a missing `psql`, and database errors all come back as tool errors — never as made-up rows. |

The server deliberately knows nothing about your schema at the MCP
layer: ask the database itself, for example
`SELECT table_name FROM information_schema.tables`, or use the CLI
`schemas` command, which groups `information_schema.columns` rows
into a per-table column list.

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # node test runner over test/*.test.ts, no network, no live database
npm run dev     # run the CLI from source via tsx
```

The core logic lives behind an injectable executor interface, which is
what the test suite drives: connection-string parsing, the guard,
pass-through querying, error propagation, and schema grouping are all
covered with a fake executor.

## License

MIT — see `LICENSE`.
