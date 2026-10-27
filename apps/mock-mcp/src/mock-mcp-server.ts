import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import express from "express";
import { createMockToolState, type MockToolState, registerMockTools } from "./mock-tools.ts";

export interface MockMcpServerOptions {
  /** TCP port; 0 (default) picks a free port. */
  port?: number;
  /** Bind address (default 127.0.0.1). */
  host?: string;
  /** When set, every /mcp request must carry `Authorization: Bearer <requiredBearer>`, else 401. */
  requiredBearer?: string;
}

/** What the mock saw on the wire; tests use it to prove which credentials were (not) forwarded. */
export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
}

export interface MockMcpServer {
  /** Streamable HTTP endpoint, e.g. http://127.0.0.1:43210/mcp */
  url: string;
  origin: string;
  port: number;
  requests: RecordedRequest[];
  state: MockToolState;
  /** How many times a tool actually executed on this server. */
  invocations(tool: string): number;
  close(): Promise<void>;
}

function headerRecord(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined) out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/**
 * Start a third-party-style MCP server (Express 5 + Streamable HTTP, stateless) for tests and local demos.
 * `/redirect?to=<url>` answers 307 to any URL so redirect handling of MCP clients can be exercised.
 */
export async function startMockMcpServer(options: MockMcpServerOptions = {}): Promise<MockMcpServer> {
  const state = createMockToolState();
  const requests: RecordedRequest[] = [];
  const handler = toNodeHandler(
    createMcpHandler(() => {
      const server = new McpServer({ name: "studix-mock-mcp", version: "0.1.0" });
      registerMockTools(server, state);
      return server;
    }),
  );

  const app = express();
  app.disable("x-powered-by");
  app.use((req, _res, next) => {
    requests.push({ method: req.method, path: req.path, headers: headerRecord(req.headers) });
    next();
  });
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });
  app.all("/redirect", (req, res) => {
    const target = typeof req.query.to === "string" ? req.query.to : "";
    if (!target) {
      res.status(400).json({ error: "missing to" });
      return;
    }
    res.redirect(307, target);
  });
  app.all("/mcp", express.json({ limit: "1mb" }), (req, res) => {
    if (options.requiredBearer && req.headers.authorization !== `Bearer ${options.requiredBearer}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    handler(req, res, req.body).catch((error: unknown) => {
      if (!res.headersSent) res.status(500).json({ error: String(error) });
    });
  });

  const host = options.host ?? "127.0.0.1";
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(options.port ?? 0, host, (error?: Error) => (error ? reject(error) : resolve(s)));
  });
  const port = (server.address() as AddressInfo).port;
  const origin = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

  return {
    url: `${origin}/mcp`,
    origin,
    port,
    requests,
    state,
    invocations: (tool) => state.invocations.get(tool) ?? 0,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
