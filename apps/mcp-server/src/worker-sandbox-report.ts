/*
 * The worker's skill sandbox readiness, read from the `sandbox` block of its `/readyz` (STUDIX_WORKER_HEALTH_URL),
 * so `studix_list_agent_runtimes` can say why agent tasks with tools cannot run (no ready skill runner) instead
 * of leaving a caller to suspect its model connection. The app itself cannot reach the worker's runners.
 */

import { createHash } from "node:crypto";

export interface WorkerSandboxReport {
  backend: "docker" | "sidecar";
  /** False when this workspace's tasks with tools would fail now (no ready runner, or not allowlisted). */
  available: boolean;
  runners?: number;
  ready?: number;
  /** A fixed, tenant-safe explanation; never the worker's runner errors or addresses. */
  reason?: string;
}

/** What `/readyz` said, before it is narrowed to one workspace. */
export interface WorkerSandboxSnapshot {
  backend: "docker" | "sidecar";
  runners?: number;
  ready: number;
  /** sha256 hex prefixes of the allowlisted workspace ids (apps/worker/src/skill-sandbox.ts workspaceHash). */
  workspaceHashes?: string[];
}

const CACHE_MS = 30_000;
const NOT_READY = "No skill runner is ready on the worker; agent tasks with tools fail until one is.";
const NOT_ALLOWED = "Agent tasks with tools are not enabled for this workspace on this server.";

const workspaceHash = (id: string) => createHash("sha256").update(id, "utf8").digest("hex").slice(0, 16);

/** Fetch `<base>/readyz` and keep its `sandbox` block when it has the expected shape. */
export async function fetchWorkerSandbox(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3_000,
): Promise<WorkerSandboxSnapshot | undefined> {
  const res = await fetchImpl(new URL("/readyz", baseUrl), { signal: AbortSignal.timeout(timeoutMs) });
  const body = (await res.json()) as { sandbox?: unknown };
  const raw = body.sandbox as Partial<Record<string, unknown>> | undefined;
  if (!raw || typeof raw !== "object") return undefined;
  if (raw.backend === "docker") return { backend: "docker", ready: 1 };
  if (raw.backend !== "sidecar") return undefined;
  const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
  const runners = count(raw.runners);
  const hashes = Array.isArray(raw.workspaceHashes)
    ? raw.workspaceHashes.filter((h): h is string => typeof h === "string")
    : undefined;
  return {
    backend: "sidecar",
    ready: count(raw.ready) ?? 0,
    ...(runners !== undefined ? { runners } : {}),
    ...(hashes ? { workspaceHashes: hashes } : {}),
  };
}

/** The snapshot as one workspace sees it. */
export function reportForWorkspace(
  snapshot: WorkerSandboxSnapshot,
  workspaceId: string,
): WorkerSandboxReport {
  if (snapshot.backend === "docker") return { backend: "docker", available: true };
  const allowed = snapshot.workspaceHashes?.includes(workspaceHash(workspaceId)) ?? true;
  if (!allowed) return { backend: "sidecar", available: false, reason: NOT_ALLOWED };
  const available = snapshot.ready > 0;
  return {
    backend: "sidecar",
    available,
    ready: snapshot.ready,
    ...(snapshot.runners !== undefined ? { runners: snapshot.runners } : {}),
    ...(available ? {} : { reason: NOT_READY }),
  };
}

/** A cached reader that never throws: an unreachable worker reports nothing rather than slowing the listing. */
export function createWorkerSandboxReader(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): (workspaceId: string) => Promise<WorkerSandboxReport | undefined> {
  let cached: { at: number; value: WorkerSandboxSnapshot | undefined } | undefined;
  return async (workspaceId) => {
    if (!cached || Date.now() - cached.at >= CACHE_MS) {
      const value = await fetchWorkerSandbox(baseUrl, fetchImpl).catch(() => undefined);
      cached = { at: Date.now(), value };
    }
    return cached.value ? reportForWorkspace(cached.value, workspaceId) : undefined;
  };
}
