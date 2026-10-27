# pgport — Build Report

Wave 1, Batch 2, MCP Rebuild 100. Clean-room rebuild of the
"postgres" MCP server, built from the public tool spec in
`harness/fixtures/postgres-tools-original.json` only. Local build
only — nothing pushed or published.

Identity: repo `pgport`, npm `@reneturcios/pgport`,
MCP name `io.github.CloudCorpRecords/pgport`, version `0.1.0`.

## Files created (19/19 per TEMPLATE.md checklist)

- `package.json` — bin `pgport: dist/cli.js`, `mcpName` set,
  scripts build=`tsc` / dev=`tsx src/cli.ts` / test=`tsx --test test/*.test.ts`
- `server.json` — description "Read-only SQL queries against a
  PostgreSQL database." = **52 chars** (≤100 ✓); npm entry carries
  `version: 0.1.0`; OCI entry `ghcr.io/cloudcorprecords/pgport:0.1.0`
  carries **no** `version` field (verified programmatically)
- `Dockerfile` — node:20-alpine two-stage, ENTRYPOINT `node /app/dist/cli.js`,
  CMD `mcp`, label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/pgport"`
- `tsconfig.json` (byte-identical to clockport's / shipcheck's, 318 bytes),
  `.gitignore`, `LICENSE` (MIT, Copyright (c) 2026 Rene Turcios),
  `README.md` (fresh text), `CHANGELOG.md` (single 0.1.0 entry, 2026-10-26)
- `src/index.ts`, `src/cli.ts` (`mcp [connection-string]`,
  `query <connection-string> <sql>`, `schemas <connection-string>`,
  `--version`; exit 2 usage / 1 query error), `src/mcp.ts`,
  `src/types.ts`, `src/pg.ts` (core logic, `VERSION = "0.1.0"`)
- `test/pg.test.ts`
- `.github/workflows/{ci,publish,publish-container,registry-publish}.yml`
  (adapted from clockport; image name and smoke-test server name changed
  to pgport)

## Implementation notes

- One MCP tool, exactly as spec'd: `query` with
  `inputSchema {"type":"object","properties":{"sql":{"type":"string"}},"required":["sql"]}`
  and description "Run a read-only SQL query against the connected
  PostgreSQL database". No per-property descriptions, no extra keys.
- **Low-level Server API, with reason:** `src/mcp.ts` registers the
  tool via `Server` from `@modelcontextprotocol/sdk/server/index.js`
  with an explicit inputSchema literal, not McpServer+zod — the
  high-level path injects `$schema` / `additionalProperties` and caps
  parity at 50% (standing rule from Wave 1). Zod still validates every
  `tools/call` argument set internally.
- Core class `PgPort` takes an injectable executor
  `{ runQuery(sql): Promise<Array<Record<string, unknown>>> }`.
  All guard, pass-through, error-propagation, and schema-grouping
  behaviour is tested against a fake executor with no network and no
  live database.
- Connection strings: `parseConnectionString` accepts `postgres://`
  and `postgresql://` URLs and returns host, port (default 5432),
  database, and optional user, with `Invalid connection string`
  errors for malformed input (bad scheme, missing host, missing
  database). For `mcp`, the string comes from the CLI argument after
  `mcp` or from `PGPORT_DATABASE_URL` / `DATABASE_URL`. No connection
  is opened at startup — verified below that the server answers
  `tools/list` with no database behind it, and only `query` calls fail.
- Read-only guard (`assertReadOnly`, in `src/pg.ts`): single-quoted
  literals are blanked out and `--` / `/* */` comments removed before
  scanning, so keywords inside literals never false-positive
  (`SELECT 'delete me'` passes, including the `''` escape). On that
  stripped view: input must be non-empty; a semicolon followed by
  non-whitespace is a rejected second statement (one trailing
  semicolon is fine); the first keyword must be `SELECT` or `WITH`;
  and the whole words INSERT, UPDATE, DELETE, DROP, ALTER, CREATE,
  TRUNCATE, GRANT, REVOKE, COPY, VACUUM are rejected anywhere. The
  scan is deliberately blunt — a real column named `update` would
  also be refused; that trade-off is documented in code and README.
- Default executor (`PsqlExecutor`): no pg driver is bundled (none is
  available in this VM and no new dependencies were added). It runs
  `execFile("psql", [url, "-v", "ON_ERROR_STOP=1", "--csv", "-c",
  "BEGIN TRANSACTION READ ONLY; <sql>; COMMIT;"])` and parses the CSV
  with a quote-aware parser (`parseCsvRows`), stripping the `BEGIN` /
  `COMMIT` tag lines psql echoes around the CSV block. A missing
  `psql` (ENOENT) and a missing executor both surface as clear
  `isError` text results — rows are never faked.
- Schema listing: `listSchemas(executor)` runs
  `SELECT table_schema, table_name, column_name FROM information_schema.columns ORDER BY table_schema, table_name, ordinal_position`
  through the executor and groups rows into per-table column lists.
  Exposed via CLI `pgport schemas <connection-string>` and as a
  `PgPort` method, and tested with a fake executor. This mirrors the
  original's schema resources in function; MCP resources themselves
  are out of scope for the parity harness and are **not** implemented
  as MCP resources (see gaps).

## Verification (exact outputs)

### 1. Build
```
$ ./node_modules/.bin/tsc ; echo exit=$?
tsc exit=0
```
`dist/` produced (cli.js with `#!/usr/bin/env node` shebang, pg.js,
mcp.js, index.js, types.js, plus .d.ts/.js.map).

### 2. Tests
```
$ ./node_modules/.bin/tsx --test test/*.test.ts
ℹ tests 24
ℹ pass 24
ℹ fail 0
```
Covers: connection-string parse (full URL, port/user defaults,
postgresql:// scheme, 7 malformed shapes), guard accepts plain
SELECT / WITH...SELECT / SELECT after leading comments, guard rejects
INSERT / UPDATE / DELETE / DROP / write hidden behind WITH /
multi-statement / empty, guard does not false-positive on keywords
inside string literals, query passes SQL through the fake executor
and returns its rows, guard runs before the executor, executor error
propagates, no-executor path errors clearly, listSchemas grouping
from fake rows (plus method form and no-executor form), and the CSV
parser (quoted commas / doubled quotes, header-only output).

### 3. MCP + CLI smoke (live, this VM)
```
initialize -> serverInfo: {"name":"pgport","version":"0.1.0"}
tools/list -> exactly the one spec tool with the spec-identical schema
tools/call query {"sql":"SELECT 1"} with NO connection configured ->
  isError: "No database connection configured: pgport has no query
  executor. Pass a postgres:// connection string to `pgport mcp`, or
  set PGPORT_DATABASE_URL / DATABASE_URL."
tools/call query with postgres://alice@localhost:5432/shop ->
  isError: "psql executable not found: ... (spawn psql ENOENT)"
CLI: --version -> 0.1.0 (exit 0); no args -> Usage (exit 2);
  query postgres://alice@localhost:5432/shop "SELECT 1" ->
  same psql error (exit 1)
psql availability check in this VM: `which psql` -> not found;
  `psql --version` -> "psql: command not found" (exit 127)
```

### 4. Parity (harness)
```
$ python3 ~/workspace/mcp-rebuild-100/harness/parity.py \
    --original ~/workspace/mcp-rebuild-100/harness/fixtures/postgres-tools-original.json \
    --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/pgport/dist/cli.js mcp" \
    --out ~/workspace/mcp-rebuild-100/builds/pgport/parity-out
verdict=PASS parity_pct=100.0 original_tools=1 rebuild_tools=1 missing=[] extra=[] schema_diffs=[]
(exit 0)
```
`parity-out/parity.json` on disk confirms: verdict PASS,
parity_pct 100.0, identical_tools 1, schema_diffs {}.
`fixture_results: SKIPPED-TOOLS-FILE-MODE` — expected harness
semantics for a tools-file original, not an error.

## Lockfile status

`package-lock.json` was copied from shipcheck with identity fields
edited; clean lockfile regen required before publish. Edited fields
(verified on disk): top-level `name`, root package `name`, and root
package `bin` key shipcheck -> pgport (dependencies are identical
ranges, so the tree is unchanged). Per the fleet lesson in
TEMPLATE.md §2 item 6, a lockfile must be generated clean (no
`node_modules` present) before first publish — **clean regeneration
is deferred to the publish wave**; do not publish from this lockfile
as-is. `node_modules` in this build dir is a `cp -a` copy of
shipcheck's (local build only, gitignored).

## Blockers / honest gaps

- **No live Postgres / no psql in this VM:** `psql` is not installed
  (`psql: command not found`, exit 127; executor path reports
  `spawn psql ENOENT`) and no PostgreSQL server exists here, so the
  psql executor's happy path — a real query returning real rows —
  could not be exercised. Its parsing is covered by `parseCsvRows`
  unit tests and its failure path is verified live above.
- **Behaviour parity unproven:** parity claimed here is tool/schema
  parity only (1/1 tools, 100.0%), per the ground-truth fixture's own
  `_source` note. Behaviour against a live database is NOT claimed.
- **MCP schema-resources not implemented:** the original also exposes
  schema information as MCP resources. pgport mirrors that function
  through `listSchemas` + the CLI `schemas` command instead; MCP
  resources are out of scope for the parity harness.
- Container build not exercised locally (no Docker run in this wave);
  the publish-container workflow smoke-tests the image at publish time.
- mcpaudit / mcpvet / shipcheck pre-publish gate not run — that
  belongs to the publish wave, not claimed here.

## Publish-gate remediation (2026-10-27)

Recorded under Rene's 2026-10-27 decision ("Remediate the 6: add param
descriptions + capability-class vet policy, then re-gate") and
`publish/GATE-POLICY.md`. This is an authorized deviation from the
parity-faithful state: a description was added to the one tool
parameter that lacked one (the `query` tool's `sql`), in the
`src/mcp.ts` schema literal only — parameter name, type and required
list are unchanged. The standing schema-only parity gap (no live
PostgreSQL in the VM) is unchanged.

- Descriptions added: 1 (the only served parameter).
- Rebuild: `npm run build` (tsc) exit 0; `tsc --noEmit` exit 0; full
  test suite 24/24 pass.
- Parity harness re-run, verbatim: **PARTIAL, parity_pct 50.0** — the
  single schema diff is the description addition (0 structural).
  Structural parity proven independently: stripping `description`
  keys from the post-remediation tools/list deep-equals the
  pre-remediation tools/list. Adjudication: the description-only
  diff is the authorized remediation itself; structural parity is
  unchanged. Full record:
  `publish/parity-remediation/pgport/parity.json`.
- Re-gate: mcpaudit **PASS 100/100 grade A** (raw:
  `publish/regate/pgport-mcpaudit.json`); mcpvet raw **REVIEW,
  risk 25** (raw: `publish/regate/pgport-mcpvet.json`), findings
  adjudicated under GATE-POLICY.md — see PUBLISH-WAVES.md.
