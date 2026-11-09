/*
 * The studix-pi-runner HTTP server (wire contract: packages/agent-runtime/src/sandbox-runner-protocol.ts).
 * Production paths are the protocol's fixed /work and /skills; tests pass their own roots in a temp dir.
 */

import { mkdir, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  RUNNER_DEFAULT_PORT,
  RUNNER_EXEC_HEADER,
  RUNNER_PROTOCOL_VERSION,
  RUNNER_ROUTES,
  type RunnerInfo,
} from "../../../packages/agent-runtime/src/sandbox-runner-protocol.ts";
import { buildChildEnv, detectToolchain, log } from "./runner-env.ts";
import { parseExec, runExec } from "./runner-exec.ts";
import { getFile, putFile } from "./runner-files.ts";
import { createAuthCheck, HttpError, readJson, sendJson } from "./runner-http.ts";
import { parseOpenRequest } from "./runner-open-request.ts";
import { createSessionManager, type SessionManager } from "./runner-session.ts";

export const MIN_TOKEN_LENGTH = 32;
const MB = 1024 * 1024;

export interface RunnerOptions {
  token: string;
  port?: number;
  host?: string;
  roots?: { work: string; skills: string };
  scratchRoots?: readonly string[];
  /** Kill every other process in the container on cleanup; only for the runner alone in its PID namespace. */
  sweepProcesses?: boolean;
  maxDiskMb?: number;
  maxFileMb?: number;
  diskCheckMs?: number;
  version?: string;
  /** Source of the toolchain variables commands inherit; never holds the token in production (see main.ts). */
  env?: NodeJS.ProcessEnv;
}

export interface Runner {
  readonly server: Server;
  readonly sessions: SessionManager;
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
}

export function createRunner(options: RunnerOptions): Runner {
  if (typeof options.token !== "string" || options.token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`runner token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const isAuthorized = createAuthCheck(options.token);
  const env = options.env ?? process.env;
  const configured = options.roots ?? { work: "/work", skills: "/skills" };
  const maxFileBytes = (options.maxFileMb ?? 2048) * MB;
  const paths = { work: configured.work, skills: configured.skills, scratch: options.scratchRoots ?? [] };
  const sessions = createSessionManager({
    paths,
    sweepProcesses: options.sweepProcesses ?? false,
    maxDiskBytes: (options.maxDiskMb ?? 8192) * MB,
    diskCheckMs: options.diskCheckMs ?? 5_000,
    baseEnv: env,
  });
  const startedAt = new Date().toISOString();
  let ready = false;
  let roots: string[] = [];
  let toolchain: Record<string, string> = {};

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://runner");
    const method = req.method ?? "GET";
    if (url.pathname === RUNNER_ROUTES.health && method === "GET") {
      sendJson(res, ready ? 200 : 503, { ok: ready });
      return;
    }
    if (!isAuthorized(req)) throw new HttpError(401, "unauthorized");
    if (!ready) throw new HttpError(503, "runner is starting");
    if (url.pathname === RUNNER_ROUTES.info && method === "GET") {
      const info: RunnerInfo = {
        protocol: RUNNER_PROTOCOL_VERSION,
        version: options.version ?? "dev",
        busy: sessions.busy,
        toolchain,
        startedAt,
      };
      sendJson(res, 200, info);
      return;
    }
    if (url.pathname === RUNNER_ROUTES.open && method === "POST") {
      const request = parseOpenRequest(await readJson(req));
      const session = await sessions.open(request.taskId, request.env, request.limits);
      if (!session) throw new HttpError(409, "runner busy");
      sendJson(res, 201, { sessionId: session.id });
      return;
    }
    const match = /^\/v1\/sessions\/([^/]+)(?:\/(exec|file))?$/.exec(url.pathname);
    if (!match?.[1]) throw new HttpError(404, "not found");
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    if (action === undefined && method === "DELETE") {
      await sessions.close(id, "closed by worker");
      res.writeHead(204).end();
      return;
    }
    const found = sessions.lookup(id);
    if (!("session" in found)) throw new HttpError(found.status, found.error);
    if (action === "exec" && method === "POST") {
      runExec(
        req,
        res,
        found.session,
        sessions,
        parseExec(req.headers[RUNNER_EXEC_HEADER], roots, roots[0]!),
      );
      return;
    }
    if (action === "file" && method === "PUT")
      return putFile(req, res, url.searchParams.get("path"), roots, maxFileBytes);
    if (action === "file" && method === "GET")
      return getFile(res, url.searchParams.get("path"), roots, maxFileBytes);
    throw new HttpError(405, "method not allowed");
  }

  // Agent bash commands travel base64url-encoded in a header; heredocs make them large.
  const server = createServer({ maxHeaderSize: MB }, (req, res) => {
    route(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
      } else {
        log("request_failed", {
          method: req.method,
          error: error instanceof Error ? error.message : String(error),
        });
        sendJson(res, 500, { error: "internal runner error" });
      }
      if (!req.complete) req.resume();
    });
  });

  return {
    server,
    sessions,
    async start() {
      await Promise.all([mkdir(paths.work, { recursive: true }), mkdir(paths.skills, { recursive: true })]);
      // Compare against resolved roots so a platform symlink (macOS /var -> /private/var) does not reject paths.
      roots = [await realpath(paths.work), await realpath(paths.skills)];
      paths.work = roots[0]!;
      paths.skills = roots[1]!;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? RUNNER_DEFAULT_PORT, options.host ?? "127.0.0.1", () => resolve());
      });
      // Recover first: its /proc sweep would kill the toolchain probes if they ran alongside it.
      await sessions.recover();
      toolchain = await detectToolchain(buildChildEnv(env, paths.work));
      ready = true;
      const { port } = server.address() as AddressInfo;
      log("start", { port, version: options.version ?? "dev", protocol: RUNNER_PROTOCOL_VERSION });
      return { port };
    },
    async stop() {
      ready = false;
      await sessions.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
