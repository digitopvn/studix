import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface ProbeResult {
  ok: boolean;
  details?: Record<string, unknown>;
}

export interface HealthServerOptions {
  port: number;
  host?: string;
  /** Liveness: the process is not wedged. */
  live: () => ProbeResult;
  /** Readiness: dependencies reachable and the worker is accepting jobs. */
  ready: () => Promise<ProbeResult>;
}

export interface HealthServer {
  port: number;
  close(): Promise<void>;
}

/** Minimal `/healthz` and `/readyz` endpoints for Kubernetes probes. Everything else is 404. */
export async function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const server: Server = createServer((req, res) => {
    const respond = (probe: ProbeResult) => {
      res.writeHead(probe.ok ? 200 : 503, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ status: probe.ok ? "ok" : "unavailable", ...probe.details }));
    };
    const path = (req.url ?? "/").split("?")[0];
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    if (path === "/healthz") {
      respond(options.live());
      return;
    }
    if (path === "/readyz") {
      options
        .ready()
        .then(respond, (err: unknown) =>
          respond({ ok: false, details: { error: err instanceof Error ? err.message : String(err) } }),
        );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
