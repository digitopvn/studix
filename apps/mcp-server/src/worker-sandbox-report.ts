/*
 * The worker's skill sandbox readiness, read from the `sandbox` block of its `/readyz` (STUDIX_WORKER_HEALTH_URL),
 * so `studix_list_agent_runtimes` can say why agent tasks with tools cannot run (no ready skill runner) instead
 * of leaving a caller to suspect its model connection. The app itself cannot reach the worker's runners.
 */

export interface WorkerSandboxReport {
  backend: "docker" | "sidecar";
  /** False when tasks with tools would fail now (no sidecar runner answered). */
  available: boolean;
  runners?: number;
  ready?: number;
  reason?: string;
}

const CACHE_MS = 30_000;

/** Fetch `<base>/readyz` and keep its `sandbox` block when it has the expected shape. */
export async function fetchWorkerSandbox(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3_000,
): Promise<WorkerSandboxReport | undefined> {
  const res = await fetchImpl(new URL("/readyz", baseUrl), { signal: AbortSignal.timeout(timeoutMs) });
  const body = (await res.json()) as { sandbox?: unknown };
  const raw = body.sandbox as Partial<Record<string, unknown>> | undefined;
  if (!raw || typeof raw !== "object") return undefined;
  if (raw.backend === "docker") return { backend: "docker", available: true };
  if (raw.backend !== "sidecar") return undefined;
  const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
  const ready = count(raw.ready) ?? 0;
  const runners = count(raw.runners);
  return {
    backend: "sidecar",
    available: ready > 0,
    ready,
    ...(runners !== undefined ? { runners } : {}),
    ...(typeof raw.reason === "string" ? { reason: raw.reason.slice(0, 300) } : {}),
  };
}

/** A cached reader that never throws: an unreachable worker reports nothing rather than slowing the listing. */
export function createWorkerSandboxReader(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): () => Promise<WorkerSandboxReport | undefined> {
  let cached: { at: number; value: WorkerSandboxReport | undefined } | undefined;
  return async () => {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
    const value = await fetchWorkerSandbox(baseUrl, fetchImpl).catch(() => undefined);
    cached = { at: Date.now(), value };
    return value;
  };
}
