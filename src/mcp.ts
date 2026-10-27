/**
 * pgport MCP server. Tool: query.
 *
 * Why the low-level Server instead of McpServer: the high-level helper
 * converts zod schemas to JSON Schema and injects two keys that are not
 * in this tool's public spec ("$schema" and "additionalProperties"),
 * which breaks exact tool-list/schema parity with the spec. This file
 * therefore serves tools/list with the spec's exact input schema,
 * while zod still validates every tools/call argument set.
 *
 * The connection string comes from the argument after `mcp`
 * (`pgport mcp postgres://...`) or from PGPORT_DATABASE_URL /
 * DATABASE_URL. No database connection is opened at startup: the
 * server answers tools/list with nothing behind it, and only a
 * tools/call for `query` touches the executor — which is where a
 * missing connection or a missing `psql` binary surfaces as an
 * isError result instead of invented rows.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createPgPort, resolveConnectionString, VERSION } from "./pg.js";

const QueryArgs = z.object({
  sql: z.string(),
});

const TOOLS = [
  {
    name: "query",
    description: "Run a read-only SQL query against the connected PostgreSQL database",
    inputSchema: {
      type: "object" as const,
      properties: {
        sql: { description: "Read-only SQL query to run against the connected PostgreSQL database.", type: "string" },
      },
      required: ["sql"],
    },
  },
];

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err: unknown) {
  return {
    content: [
      { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
    ],
    isError: true,
  };
}

// argv looks like: [node, cli.js, "mcp", maybe-connection-string].
const argv = process.argv.slice(2);
const mcpIndex = argv.indexOf("mcp");
const explicit = mcpIndex >= 0 ? argv[mcpIndex + 1] : undefined;
const connectionString = resolveConnectionString(explicit);
const port = createPgPort(connectionString);

const server = new Server(
  { name: "pgport", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === "query") {
      const parsed = QueryArgs.parse(args ?? {});
      const rows = await port.query(parsed.sql);
      return textResult(rows);
    }
  } catch (err) {
    return errorResult(err);
  }
  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
