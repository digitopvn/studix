import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { StudixError } from "@studix/shared";

/*
 * A skill sandbox: one container per agent task, created when the task starts and removed when it ends.
 * The agent's tools (bash, read, write, edit, ls) run inside it through `docker exec`; the agent loop, the
 * model credential and every server secret stay in the worker process. See docs/decisions/0018-skill-sandbox.md.
 */

/** Where things live inside the container. */
export const SANDBOX_WORK_DIR = "/work";
export const SANDBOX_SKILLS_DIR = "/skills";
/** Results the task leaves for the job (for example `out/video.mp4`). */
export const SANDBOX_OUTPUT_DIR = `${SANDBOX_WORK_DIR}/out`;

export interface SandboxLimits {
  /** CPU cores (docker `--cpus`). */
  cpus: number;
  memoryMb: number;
  pids: number;
  /** The container is killed when this passes, whatever the agent is doing. */
  wallTimeMs: number;
}

export interface SandboxOpenRequest {
  /** Unique per task; names the container and its host scratch directory. */
  taskId: string;
  /** The task's own provider keys and nothing else. Passed to docker by name, never on its command line. */
  env: Readonly<Record<string, string>>;
  /** Host directory mounted read-only at /skills, when the task has skills. */
  skillsDir?: string;
  limits: SandboxLimits;
  signal: AbortSignal;
}

export interface SandboxExecOptions {
  cwd?: string;
  onData?: (chunk: Buffer) => void;
  signal?: AbortSignal;
  /** Seconds, as the Pi bash tool passes it. */
  timeoutSeconds?: number;
  stdin?: Buffer | string;
}

export interface SandboxSession {
  readonly id: string;
  /** Runs `sh -c command` in the container; resolves with the exit code (null when it was killed). */
  exec(command: string, options?: SandboxExecOptions): Promise<{ exitCode: number | null }>;
  /** Runs argv directly (no shell) and returns stdout; rejects with the exit code and stderr on failure. */
  run(argv: readonly string[], options?: { stdin?: Buffer | string; signal?: AbortSignal }): Promise<Buffer>;
  /** Streams a container file to a host path outside the container's mounts (symlinks resolve in the container). */
  copyOut(containerPath: string, hostPath: string): Promise<void>;
  close(): Promise<void>;
}

export interface SandboxDriver {
  readonly id: string;
  open(request: SandboxOpenRequest): Promise<SandboxSession>;
}

export interface DockerSandboxOptions {
  image: string;
  /** Host parent of the per-task directories mounted at /work. */
  workRoot: string;
  /** Docker network; default `bridge` (open egress). A dedicated network can fence off internal ranges. */
  network?: string;
  docker?: string;
  /** Test seam for the docker CLI. */
  spawnDocker?: (args: readonly string[], env: NodeJS.ProcessEnv) => ChildProcess;
}

const CONTAINER_PREFIX = "studix-sbx-";
const SANDBOX_LABEL = "studix.sandbox=1";
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;

/** The environment of the docker CLI itself: enough to find the daemon, nothing of the server's secrets. */
function dockerEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const keep = [
    "PATH",
    "SystemRoot",
    "SYSTEMROOT",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of keep) if (process.env[name] !== undefined) env[name] = process.env[name];
  for (const name of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_CERT_PATH",
    "DOCKER_TLS_VERIFY",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { ...env, ...extra };
}

/** `docker run` arguments of one task's container. Exported for tests. */
export function dockerRunArgs(
  options: Pick<DockerSandboxOptions, "image" | "network">,
  request: Pick<SandboxOpenRequest, "env" | "limits" | "skillsDir">,
  name: string,
  hostWorkDir: string,
): string[] {
  const { limits } = request;
  const args = [
    "run",
    "--detach",
    "--rm",
    "--init",
    "--name",
    name,
    "--label",
    SANDBOX_LABEL,
    "--network",
    options.network ?? "bridge",
    "--cpus",
    String(limits.cpus),
    "--memory",
    `${limits.memoryMb}m`,
    "--memory-swap",
    `${limits.memoryMb}m`,
    "--pids-limit",
    String(limits.pids),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,exec,size=2g",
    "--shm-size",
    "1g",
    "--user",
    "1000:1000",
    "--workdir",
    SANDBOX_WORK_DIR,
    "--volume",
    `${hostWorkDir}:${SANDBOX_WORK_DIR}:rw`,
    "--env",
    `HOME=${SANDBOX_WORK_DIR}/.home`,
  ];
  if (request.skillsDir) args.push("--volume", `${request.skillsDir}:${SANDBOX_SKILLS_DIR}:ro`);
  for (const name of Object.keys(request.env).sort()) {
    if (!ENV_NAME.test(name)) {
      throw new StudixError("VALIDATION", `Sandbox env name ${name.slice(0, 40)} is not allowed`, {
        retryable: false,
      });
    }
    // Name only: docker reads the value from its own environment, so it never shows in a process list.
    args.push("--env", name);
  }
  args.push(options.image, "sleep", "infinity");
  return args;
}

function collect(
  child: ChildProcess,
  stdin?: Buffer | string,
): Promise<{ code: number | null; out: Buffer; err: string }> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    let err = "";
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => {
      if (err.length < 4000) err += c.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, out: Buffer.concat(out), err }));
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
  });
}

export function createDockerSandboxDriver(options: DockerSandboxOptions): SandboxDriver {
  const docker = options.docker ?? "docker";
  const spawnDocker =
    options.spawnDocker ??
    ((args: readonly string[], env: NodeJS.ProcessEnv) =>
      spawn(docker, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }));

  async function cli(
    args: readonly string[],
    extraEnv?: Readonly<Record<string, string>>,
    stdin?: Buffer | string,
  ) {
    const result = await collect(spawnDocker(args, dockerEnv(extraEnv)), stdin);
    if (result.code !== 0) {
      throw new StudixError("UNAVAILABLE", `docker ${args[0]} failed: ${result.err.trim().slice(0, 500)}`, {
        retryable: false,
        suggestedAction: "Check that the worker can reach a Docker daemon and that the sandbox image exists.",
      });
    }
    return result.out;
  }

  return {
    id: "docker",
    async open(request) {
      const name = `${CONTAINER_PREFIX}${request.taskId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 60)}`;
      const hostWorkDir = join(options.workRoot, name);
      await rm(hostWorkDir, { recursive: true, force: true });
      await mkdir(join(hostWorkDir, ".home"), { recursive: true });
      await mkdir(join(hostWorkDir, "out"), { recursive: true });
      await cli(dockerRunArgs(options, request, name, hostWorkDir), request.env);

      let closed = false;
      const running = new Set<ChildProcess>();
      const close = async () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
        for (const child of running) child.kill("SIGKILL");
        await cli(["rm", "--force", name]).catch(() => undefined);
        await rm(hostWorkDir, { recursive: true, force: true }).catch(() => undefined);
      };
      const onAbort = () => void close();
      request.signal.addEventListener("abort", onAbort, { once: true });
      // The wall-time cap holds even when the loop above never checks it.
      const timer = setTimeout(() => void close(), request.limits.wallTimeMs);
      timer.unref?.();

      const assertOpen = () => {
        if (closed) {
          throw new StudixError("TIMEOUT", "The sandbox was stopped", {
            retryable: false,
            details: { cap: "time" },
          });
        }
      };

      const execChild = (argv: readonly string[], interactive: boolean, cwd?: string) => {
        const args = [
          "exec",
          ...(interactive ? ["--interactive"] : []),
          ...(cwd ? ["--workdir", cwd] : []),
          name,
          ...argv,
        ];
        const child = spawnDocker(args, dockerEnv());
        running.add(child);
        child.once("close", () => running.delete(child));
        return child;
      };

      return {
        id: name,
        async exec(command, opts = {}) {
          assertOpen();
          const child = execChild(["sh", "-c", command], opts.stdin !== undefined, opts.cwd);
          const kill = () => child.kill("SIGKILL");
          opts.signal?.addEventListener("abort", kill, { once: true });
          const timeout = opts.timeoutSeconds
            ? setTimeout(kill, Math.max(1, opts.timeoutSeconds) * 1000)
            : undefined;
          try {
            return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
              child.stdout?.on("data", (c: Buffer) => opts.onData?.(c));
              child.stderr?.on("data", (c: Buffer) => opts.onData?.(c));
              child.once("error", reject);
              child.once("close", (code, sig) => resolve({ exitCode: sig ? null : code }));
              if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
              else child.stdin?.end();
            });
          } finally {
            if (timeout) clearTimeout(timeout);
            opts.signal?.removeEventListener("abort", kill);
          }
        },
        async run(argv, opts = {}) {
          assertOpen();
          const child = execChild(argv, opts.stdin !== undefined);
          const kill = () => child.kill("SIGKILL");
          opts.signal?.addEventListener("abort", kill, { once: true });
          try {
            const result = await collect(child, opts.stdin);
            if (result.code !== 0) {
              throw new Error(result.err.trim().slice(0, 500) || `exit code ${result.code}`);
            }
            return result.out;
          } finally {
            opts.signal?.removeEventListener("abort", kill);
          }
        },
        async copyOut(containerPath, hostPath) {
          assertOpen();
          // Read through the container so a symlink the task planted resolves inside it, not on the host.
          const child = execChild(["cat", "--", containerPath], false);
          const file = createWriteStream(hostPath);
          let err = "";
          child.stderr?.on("data", (c: Buffer) => {
            if (err.length < 2000) err += c.toString("utf8");
          });
          child.stdout?.pipe(file);
          child.stdin?.end();
          const code = await new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
          });
          await new Promise<void>((resolve) => file.close(() => resolve()));
          if (code !== 0) {
            throw new StudixError(
              "VALIDATION",
              `The sandbox has no readable ${containerPath}: ${err.trim()}`,
              {
                retryable: false,
              },
            );
          }
        },
        close,
      };
    },
  };
}

/** Removes sandbox containers a crashed worker left behind (label `studix.sandbox=1`). */
export async function sweepDockerSandboxes(docker = "docker"): Promise<number> {
  const list = await collect(
    spawn(docker, ["ps", "--all", "--quiet", "--filter", `label=${SANDBOX_LABEL}`], {
      env: dockerEnv(),
      windowsHide: true,
    }),
  );
  const ids = list.out.toString("utf8").split(/\s+/).filter(Boolean);
  if (ids.length > 0) {
    await collect(spawn(docker, ["rm", "--force", ...ids], { env: dockerEnv(), windowsHide: true }));
  }
  return ids.length;
}
