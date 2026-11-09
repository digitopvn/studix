/**
 * Builds the `sidecars` payload of the worker project: a pool of `pi-runner` containers that run the
 * skill sandbox's tools inside the worker's own pod (docs/DEPLOYMENT.md#skill-sandbox-worker, ADR-0025).
 * Pure and dependency-free so deploy.ts and its test can both import it.
 *
 * Contract with the runner (packages/agent-runtime/src/sandbox-runner-protocol.ts): the container reads
 * STUDIX_RUNNER_TOKEN, which TOSE copies from the project env key STUDIX_RUNNER_<n>_TOKEN (the worker reads
 * the same key). The API port is fixed here as a container arg (`--port 7070+n`), so no env typo can make two
 * runners collide; the kubelet probes GET /healthz on the API port + RUNNER_HEALTH_PORT_OFFSET, the one
 * listener the runner opens on the Pod IP. The runner's disk and file caps default to fit TOSE's sidecar
 * storage limits (2 GiB ephemeral, 1 GiB /tmp), so nothing else is passed.
 */

import { RUNNER_HEALTH_PORT_OFFSET } from "../../packages/agent-runtime/src/sandbox-runner-protocol.ts";

export const MAX_WORKER_RUNNERS = 3;
const BASE_PORT = 7070;

export interface WorkerSidecarOptions {
  /** Number of runners, 1..3 (TOSE allows three sidecars per project). */
  count: number;
  /** Digest-pinned runner image (`repo@sha256:<64 hex>`); TOSE refuses a tag. */
  image: string;
  /** TOSE workspace registry credential that can pull the (private) image. */
  registryCredentialId?: string;
  /** Cores per runner (TOSE accepts 0.05 to 4). */
  cpu: string;
  /** GiB per runner (TOSE accepts 0.0625 to 8). */
  ram: string;
}

export interface WorkerSidecar {
  name: string;
  image: string;
  registry_credential_id?: string;
  cpu: string;
  ram: string;
  port: number;
  health_path: string;
  run_as_user: number;
  args: string[];
  env: { name: string; from_env: string }[];
}

/** Loopback port the n-th runner (1-based) listens on; the worker's STUDIX_SANDBOX_RUNNERS lists these. */
export const runnerPort = (n: number): number => BASE_PORT + n;

export function buildWorkerSidecars(options: WorkerSidecarOptions): WorkerSidecar[] {
  const { count, image, registryCredentialId, cpu, ram } = options;
  if (!Number.isInteger(count) || count < 1 || count > MAX_WORKER_RUNNERS) {
    throw new Error(`TOSE_WORKER_RUNNERS must be an integer from 1 to ${MAX_WORKER_RUNNERS}`);
  }
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) throw new Error("STUDIX_RUNNER_IMAGE must be pinned by digest");
  for (const [name, value] of [
    ["TOSE_RUNNER_CPU", cpu],
    ["TOSE_RUNNER_RAM", ram],
  ] as const) {
    if (!(Number(value) > 0)) throw new Error(`${name} must be a positive number`);
  }
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return {
      name: `pi-runner-${n}`,
      image,
      ...(registryCredentialId ? { registry_credential_id: registryCredentialId } : {}),
      cpu,
      ram,
      port: runnerPort(n) + RUNNER_HEALTH_PORT_OFFSET,
      health_path: "/healthz",
      run_as_user: 1000,
      args: ["--port", String(runnerPort(n))],
      env: [{ name: "STUDIX_RUNNER_TOKEN", from_env: `STUDIX_RUNNER_${n}_TOKEN` }],
    };
  });
}
