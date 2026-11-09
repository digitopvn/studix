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
  RUNNER_HEALTH_PORT_OFFSET,
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
/**
 * Defaults sized for a TOSE sidecar: 1 GiB /tmp and a 2 GiB ephemeral-storage limit for the whole container,
 * past which the kubelet evicts the Pod (the worker included). A session is closed well before that.
 */
export const DEFAULT_MAX_DISK_MB = 1536;
export const DEFAULT_MAX_FILE_MB = 1024;

export interface RunnerOptions {
  token: string;
  port?: number;
  host?: string;
  /**
   * Where GET /healthz is also served for Kubernetes probes, which call the Pod IP: `{ port, host }`, by default
   * API port + RUNNER_HEALTH_PORT_OFFSET on 0.0.0.0. null serves health on the API listener only (tests).
   */
  health?: { port: number; host: string } | null;
  /** See SessionConfig.onFatal. */
  onFatal?: (reason: string) => void;
  roots?: { work: string; skills: string };
  scratchRoots?: readonly string[];
  /** Kill every other process in the container on cleanup; only for the runner alone in its PID namespace. */
  sweepProcesses?: boolean;
  maxDiskMb?: number;
  /** See SessionConfig.pathCaps (in MB here). */
  pathCapsMb?: readonly { path: string; maxMb: number }[];
  maxFileMb?: number;
  diskCheckMs?: number;
  version?: string;
  /** Source of the toolchain variables commands inherit; never holds the token in production (see main.ts). */
  env?: NodeJS.ProcessEnv;
}

export interface Runner {
  readonly server: Server;
  readonly sessions: SessionManager;
  start(): Promise<{ port: number; healthPort: number | null }>;
  stop(): Promise<void>;
}

export function createRunner(options: RunnerOptions): Runner {
  if (typeof options.token !== "string" || options.token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`runner token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const isAuthorized = createAuthCheck(options.token);
  const env = options.env ?? process.env;
  const configured = options.roots ?? { work: "/work", skills: "/skills" };
  const maxFileBytes = (options.maxFileMb ?? DEFAULT_MAX_FILE_MB) * MB;
  const paths = { work: configured.work, skills: configured.skills, scratch: options.scratchRoots ?? [] };
  const sessions = createSessionManager({
    paths,
    sweepProcesses: options.sweepProcesses ?? false,
    maxDiskBytes: (options.maxDiskMb ?? DEFAULT_MAX_DISK_MB) * MB,
    diskCheckMs: options.diskCheckMs ?? 2_000,
    pathCaps: (options.pathCapsMb ?? []).map((c) => ({ path: c.path, maxBytes: c.maxMb * MB })),
    baseEnv: env,
    onFatal: options.onFatal,
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
    if (url.pathname === RUNNER_ROUTES.reset && method === "POST") {
      await sessions.reset();
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === RUNNER_ROUTES.open && method === "DELETE") {
      const taskId = url.searchParams.get("taskId");
      if (!taskId) throw new HttpError(400, "taskId is required");
      await sessions.closeByTask(taskId);
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === RUNNER_ROUTES.open && method === "POST") {
      const request = parseOpenRequest(await readJson(req));
      const session = await sessions.open(request.taskId, request.env, request.limits);
      // A null after an accepted open means closeByTask/reset raced it; either way there is no session to use.
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
    if (action === "file" && (method === "PUT" || method === "GET")) {
      const path = url.searchParams.get("path");
      return sessions.trackTransfer(
        found.session,
        req,
        method === "PUT"
          ? putFile(req, res, path, roots, maxFileBytes)
          : getFile(res, path, roots, maxFileBytes),
      );
    }
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

  // Probes reach the Pod IP; this listener answers GET /healthz and nothing else, without a token.
  const healthServer = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://runner").pathname;
    if (path === RUNNER_ROUTES.health && req.method === "GET")
      sendJson(res, ready ? 200 : 503, { ok: ready });
    else sendJson(res, 404, { error: "not found" });
  });
  let healthListening = false;

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
      const apiPort = (server.address() as AddressInfo).port;
      const health =
        options.health === undefined
          ? { port: apiPort + RUNNER_HEALTH_PORT_OFFSET, host: "0.0.0.0" }
          : options.health;
      if (health) {
        await new Promise<void>((resolve, reject) => {
          healthServer.once("error", reject);
          healthServer.listen(health.port, health.host, () => resolve());
        });
        healthListening = true;
      }
      // Recover first: its /proc sweep would kill the toolchain probes if they ran alongside it.
      await sessions.recover();
      toolchain = await detectToolchain(buildChildEnv(env, paths.work));
      ready = true;
      const { port } = server.address() as AddressInfo;
      const healthPort = healthListening ? (healthServer.address() as AddressInfo).port : null;
      log("start", {
        port,
        healthPort,
        version: options.version ?? "dev",
        protocol: RUNNER_PROTOCOL_VERSION,
      });
      return { port, healthPort };
    },
    async stop() {
      ready = false;
      await sessions.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (healthListening) {
        healthServer.closeAllConnections();
        await new Promise<void>((resolve) => healthServer.close(() => resolve()));
      }
    },
  };
}
