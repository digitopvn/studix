/*
 * The single session of a runner: open, the wall-time and disk caps, the process groups its commands run in,
 * and the close that kills them and wipes every writable path. A closed session id keeps its reason for a while
 * so a late call learns why (410) instead of a bare 404.
 */
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RunnerLimits } from "../../../packages/agent-runtime/src/sandbox-runner-protocol.ts";
import { buildChildEnv, log } from "./runner-env.ts";
import { emptyDir, emptyIfExists, killGroup, measureDiskBytes, sweepProcesses } from "./runner-sweep.ts";

export interface RunnerPaths {
  work: string;
  skills: string;
  /** Writable scratch paths wiped between sessions and counted by the disk cap (/tmp, /var/tmp, /dev/shm). */
  scratch: readonly string[];
}

export interface SessionConfig {
  paths: RunnerPaths;
  /** Kill every other process of the container on cleanup (production, Linux, the runner alone in its PID ns). */
  sweepProcesses: boolean;
  maxDiskBytes: number;
  diskCheckMs: number;
  /** The runner's environment, the source of the toolchain variables a command inherits. */
  baseEnv: NodeJS.ProcessEnv;
}

export interface Session {
  readonly id: string;
  readonly taskId: string;
  readonly limits: RunnerLimits;
  readonly env: Record<string, string>;
  closed: boolean;
}

interface LiveSession extends Session {
  openedAt: number;
  children: Map<number, Promise<void>>;
  timers: NodeJS.Timeout[];
}

export type SessionLookup = { session: Session } | { status: 404 | 410; error: string };

const CLOSED_MEMORY = 64;

export function createSessionManager(config: SessionConfig) {
  let current: LiveSession | null = null;
  let cleaning: Promise<void> | null = null;
  const closedReasons = new Map<string, string>();

  async function cleanup(): Promise<void> {
    if (config.sweepProcesses) await sweepProcesses();
    const { work, skills, scratch } = config.paths;
    await Promise.all([emptyDir(work), emptyDir(skills), ...scratch.map((dir) => emptyIfExists(dir))]);
  }

  function remember(id: string, reason: string): void {
    closedReasons.set(id, reason);
    if (closedReasons.size > CLOSED_MEMORY) closedReasons.delete(closedReasons.keys().next().value as string);
  }

  async function close(id: string, reason: string): Promise<void> {
    const session = current;
    if (!session || session.id !== id || session.closed) return cleaning ?? undefined;
    session.closed = true;
    remember(id, reason);
    for (const timer of session.timers) clearTimeout(timer);
    for (const pgid of session.children.keys()) killGroup(pgid);
    cleaning = (async () => {
      // Wait for the killed commands to exit (bounded), so their streams end before the paths are wiped.
      await Promise.race([Promise.all(session.children.values()), delay(5_000)]);
      await cleanup().catch((error: unknown) => log("cleanup_failed", { error: String(error) }));
      log("close", {
        sessionId: id,
        taskId: session.taskId,
        reason,
        durationMs: Date.now() - session.openedAt,
      });
      current = null;
      cleaning = null;
    })();
    return cleaning;
  }

  async function checkDisk(session: LiveSession): Promise<void> {
    const { work, skills, scratch } = config.paths;
    const bytes = await measureDiskBytes([work, skills, ...scratch]);
    if (session.closed || bytes === null || bytes <= config.maxDiskBytes) return;
    log("disk_cap", { sessionId: session.id, taskId: session.taskId, bytes, maxBytes: config.maxDiskBytes });
    await close(session.id, "disk cap");
  }

  function scheduleDiskCheck(session: LiveSession): void {
    const timer = setTimeout(() => {
      void checkDisk(session)
        .catch((error: unknown) => log("disk_check_failed", { error: String(error) }))
        .finally(() => {
          if (!session.closed) scheduleDiskCheck(session);
        });
    }, config.diskCheckMs);
    session.timers.push(timer);
  }

  return {
    get busy(): boolean {
      return current !== null || cleaning !== null;
    },

    /** Startup crash recovery: whatever a previous runner process left behind is killed and wiped. */
    recover: cleanup,

    /** Opens the session, or returns null when the runner is busy. */
    async open(taskId: string, env: Record<string, string>, limits: RunnerLimits): Promise<Session | null> {
      if (current || cleaning) return null;
      const { work, skills } = config.paths;
      const session: LiveSession = {
        id: randomBytes(16).toString("base64url"),
        taskId,
        limits,
        env: buildChildEnv(config.baseEnv, join(work, ".home"), env),
        closed: false,
        openedAt: Date.now(),
        children: new Map(),
        timers: [],
      };
      current = session;
      try {
        await Promise.all([emptyDir(work), emptyDir(skills)]);
        for (const sub of ["out", "in", ".home"]) await mkdir(join(work, sub), { recursive: true });
      } catch (error) {
        session.closed = true;
        current = null;
        throw error;
      }
      session.timers.push(setTimeout(() => void close(session.id, "wall time"), limits.wallTimeMs));
      scheduleDiskCheck(session);
      log("open", { sessionId: session.id, taskId, pids: limits.pids, wallTimeMs: limits.wallTimeMs });
      return session;
    },

    lookup(id: string): SessionLookup {
      if (current && current.id === id && !current.closed) return { session: current };
      const reason = closedReasons.get(id);
      if (reason !== undefined) return { status: 410, error: `session closed: ${reason}` };
      return { status: 404, error: "no such session" };
    },

    /** Registers a spawned command (its pid is its process group) so close kills it. */
    track(session: Session, child: ChildProcess): void {
      const live = session as LiveSession;
      const pid = child.pid;
      if (pid === undefined) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      live.children.set(pid, exited);
      void exited.then(() => live.children.delete(pid));
    },

    close,

    /** Closes whatever session is open (SIGTERM). */
    async shutdown(): Promise<void> {
      if (current) await close(current.id, "shutdown");
      else if (cleaning) await cleaning;
    },
  };
}

export type SessionManager = ReturnType<typeof createSessionManager>;
