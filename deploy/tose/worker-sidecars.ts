/**
 * Builds the `sidecars` payload of the worker project: a pool of `pi-runner` containers that run the
 * skill sandbox's tools inside the worker's own pod (docs/DEPLOYMENT.md#skill-sandbox-worker, ADR-0025).
 * Pure and dependency-free so deploy.ts and its test can both import it.
 *
 * Contract with the runner (packages/agent-runtime/src/sandbox-runner-protocol.ts, RUNNER_ENV): the
 * container reads STUDIX_RUNNER_TOKEN and STUDIX_RUNNER_PORT. TOSE copies each from a key of the
 * project's own env, so the project needs STUDIX_RUNNER_<n>_TOKEN and STUDIX_RUNNER_<n>_PORT for every
 * runner (the worker reads the tokens too; the port key just mirrors the 7070+n listen port).
 */

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
      port: runnerPort(n),
      health_path: "/healthz",
      run_as_user: 1000,
      env: [
        { name: "STUDIX_RUNNER_TOKEN", from_env: `STUDIX_RUNNER_${n}_TOKEN` },
        { name: "STUDIX_RUNNER_PORT", from_env: `STUDIX_RUNNER_${n}_PORT` },
      ],
    };
  });
}
