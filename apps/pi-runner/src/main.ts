/*
 * studix-pi-runner entry point: `node apps/pi-runner/src/main.ts [--token-stdin]` (Node type stripping, no build,
 * no npm dependency). The API listens on 127.0.0.1:$STUDIX_RUNNER_PORT (7071) inside the Pod; GET /healthz alone is
 * also served on 0.0.0.0 at that port + RUNNER_HEALTH_PORT_OFFSET (7171) for the kubelet's probes.
 *
 * The token. Session commands run as the runner's own uid, so they can read /proc/<pid>/environ of every
 * process in the container, pid 1 included, and deleting a variable from process.env does not change what
 * /proc/self/environ shows (it is the exec-time snapshot). The image therefore never lets the token reach a
 * long-lived process's environment: entrypoint.sh moves it to stdin and execs `env -u STUDIX_RUNNER_TOKEN tini
 * -- node main.ts --token-stdin`, so neither tini (pid 1) nor the runner has it in any /proc/<pid>/environ. The runner
 * still deletes it from process.env (the plain `node main.ts` path, local use) and builds every child
 * environment from an allow-list (runner-env.ts), so no command ever inherits it.
 * Residual: the token lives in the runner's memory; a same-uid process could read it through ptrace or
 * /proc/<pid>/mem only where the kernel and seccomp profile allow ptrace between same-uid siblings
 * (Yama ptrace_scope 0 and an unconfined seccomp profile). Keep the runtime's default seccomp profile on.
 */

import {
  RUNNER_DEFAULT_PORT,
  RUNNER_ENV,
  RUNNER_HEALTH_PORT_OFFSET,
} from "../../../packages/agent-runtime/src/sandbox-runner-protocol.ts";
import { log } from "./runner-env.ts";
import { createRunner, DEFAULT_MAX_DISK_MB, DEFAULT_MAX_FILE_MB, MIN_TOKEN_LENGTH } from "./runner-server.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

/** `--port <n>` (the container args) wins over STUDIX_RUNNER_PORT. */
function portArg(): string | undefined {
  const at = process.argv.indexOf("--port");
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function positiveNumber(name: string, fallback: number, raw = process.env[name]): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function fail(message: string): never {
  log("start_failed", { error: message });
  process.exit(1);
}

async function main(): Promise<void> {
  const token = process.argv.includes("--token-stdin")
    ? await readStdin()
    : (process.env[RUNNER_ENV.token] ?? "");
  delete process.env[RUNNER_ENV.token];
  if (token.length < MIN_TOKEN_LENGTH)
    fail(`${RUNNER_ENV.token} must be set to at least ${MIN_TOKEN_LENGTH} characters`);

  let port: number;
  let maxDiskMb: number;
  let maxFileMb: number;
  try {
    port = positiveNumber(RUNNER_ENV.port, RUNNER_DEFAULT_PORT, portArg() ?? process.env[RUNNER_ENV.port]);
    if (!Number.isInteger(port) || port > 65_535) throw new Error(`${RUNNER_ENV.port} must be a TCP port`);
    if (port + RUNNER_HEALTH_PORT_OFFSET > 65_535)
      throw new Error(`${RUNNER_ENV.port} leaves no room for the health port`);
    maxDiskMb = positiveNumber(RUNNER_ENV.maxDiskMb, DEFAULT_MAX_DISK_MB);
    maxFileMb = positiveNumber(RUNNER_ENV.maxFileMb, DEFAULT_MAX_FILE_MB);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const runner = createRunner({
    token,
    port,
    maxDiskMb,
    maxFileMb,
    version: process.env.STUDIX_RUNNER_VERSION || "dev",
    // /home/node: the image user's home; HOME points into /work, but a command can still write there.
    scratchRoots: ["/tmp", "/var/tmp", "/dev/shm", "/home/node"],
    // The /proc sweep assumes the runner owns its PID namespace (one container, shareProcessNamespace off).
    sweepProcesses: process.platform === "linux",
    // A session's processes or files that cleanup could not remove must not reach the next session: exit, so
    // the container restarts and the kernel kills everything left in its PID namespace.
    onFatal: () => process.exit(1),
  });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("stop", { signal });
    runner.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        log("stop_failed", { error: String(error) });
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  await runner.start();
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
