/**
 * CLI entry: `pnpm --filter @studix/mock-mcp start`.
 * Env: MOCK_MCP_PORT (default 8790), MOCK_MCP_HOST (default 127.0.0.1),
 * MOCK_MCP_BEARER (optional; when set, requests must present it as a bearer token).
 */
import { startMockMcpServer } from "./mock-mcp-server.ts";

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 8790;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`MOCK_MCP_PORT must be an integer between 0 and 65535, got "${value}"`);
  }
  return port;
}

try {
  const server = await startMockMcpServer({
    port: parsePort(process.env.MOCK_MCP_PORT),
    host: process.env.MOCK_MCP_HOST || "127.0.0.1",
    requiredBearer: process.env.MOCK_MCP_BEARER || undefined,
  });
  process.stderr.write(`mock MCP server listening on ${server.url}\n`);
  const shutdown = () => {
    server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  process.stderr.write(
    `mock MCP server failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
