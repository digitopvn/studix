/*
 * The single session of a runner: open, the wall-time and disk caps, the process groups its commands run in,
 * and the close that kills them and wipes every writable path. A closed session id keeps its reason for a while
 * so a late call learns why (410) instead of a bare 404.
 */
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RunnerLimits } from "../../../packages/agent-runtime/src/sandbox-runner-protocol.ts";
import { buildChildEnv, log } from "./runner-env.ts";
import { emptyDir, emptyIfExists, killGroup, measureDiskBytes, sweepProcesses } from "./runner-sweep.ts";

export interface RunnerPaths {
  work: string;
  skills: string;
  /** Writable scratch paths wiped between sessions and counted by the disk cap (/tmp, /var/tmp, /run/lock, /home/node). */
  scratch: readonly string[];
}

export interface SessionConfig {
  paths: RunnerPaths;
  /** Kill every other process of the container on cleanup (production, Linux, the runner alone in its PID ns). */
  sweepProcesses: boolean;
  maxDiskBytes: number;
  /** Tighter caps on single paths (TOSE's 1 GiB /tmp), checked with the total. */
  pathCaps?: readonly { path: string; maxBytes: number }[];
  diskCheckMs: number;
  /** The runner's environment, the source of the toolchain variables a command inherits. */
  baseEnv: NodeJS.ProcessEnv;
  /**
   * Called when cleanup could not kill or wipe what a session left, so the next session would inherit it.
   * Production exits the process: the container restarts and the kernel kills everything in its PID namespace.
   * Unset (tests), the failure is logged and the runner stays usable.
   */
  onFatal?: (reason: string) => void;
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
  /** In-flight file transfers: close aborts them and waits for their handlers, so no upload writes after the wipe. */
  transfers: Map<IncomingMessage, Promise<unknown>>;
  timers: NodeJS.Timeout[];
}

export type SessionLookup = { session: Session } | { status: 410; error: string };

const CLOSED_MEMORY = 64;

export function createSessionManager(config: SessionConfig) {
  let current: LiveSession | null = null;
  let cleaning: Promise<void> | null = null;
  const closedReasons = new Map<string, string>();

  async function cleanup(): Promise<void> {
    if (config.sweepProcesses && !(await sweepProcesses())) {
      throw new Error("processes of the previous session survived the sweep");
    }
    const { work, skills, scratch } = config.paths;
    await Promise.all([emptyDir(work), emptyDir(skills), ...scratch.map((dir) => emptyIfExists(dir))]);
  }

  async function cleanupOrDie(): Promise<void> {
    try {
      await cleanup();
    } catch (error) {
      log("cleanup_failed", { error: String(error) });
      config.onFatal?.(String(error));
    }
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
    for (const req of session.transfers.keys()) req.destroy();
    cleaning = (async () => {
      // Wait for the killed commands and aborted transfers to end (bounded), so nothing writes after the wipe.
      await Promise.race([
        Promise.all([...session.children.values(), ...session.transfers.values()]),
        delay(5_000),
      ]);
      await cleanupOrDie();
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
    if (session.closed) return;
    if (bytes !== null && bytes > config.maxDiskBytes) {
      log("disk_cap", {
        sessionId: session.id,
        taskId: session.taskId,
        bytes,
        maxBytes: config.maxDiskBytes,
      });
      await close(session.id, "disk cap");
      return;
    }
    for (const cap of config.pathCaps ?? []) {
      const used = await measureDiskBytes([cap.path]);
      if (session.closed) return;
      if (used !== null && used > cap.maxBytes) {
        log("disk_cap", {
          sessionId: session.id,
          taskId: session.taskId,
          path: cap.path,
          bytes: used,
          maxBytes: cap.maxBytes,
        });
        await close(session.id, `disk cap of ${cap.path}`);
        return;
      }
    }
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

    /** Closes the open session when it belongs to taskId (an open the worker gave up on). */
    async closeByTask(taskId: string): Promise<void> {
      if (current && current.taskId === taskId && !current.closed)
        await close(current.id, "abandoned by worker");
      else if (cleaning) await cleaning;
    },

    /** Closes whatever session is open (a restarted worker reclaiming its runners). */
    async reset(): Promise<void> {
      if (current && !current.closed) await close(current.id, "reset by worker");
      else if (cleaning) await cleaning;
    },

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
        transfers: new Map(),
        timers: [],
      };
      current = session;
      try {
        await Promise.all([emptyDir(work), emptyDir(skills)]);
        for (const sub of ["out", "in", ".home", ".tmp"]) await mkdir(join(work, sub), { recursive: true });
      } catch (error) {
        if (!session.closed) {
          session.closed = true;
          current = null;
        }
        throw error;
      }
      // Closed by closeByTask/reset while preparing: the worker already gave up on this open.
      if (session.closed) return null;
      session.timers.push(setTimeout(() => void close(session.id, "wall time"), limits.wallTimeMs));
      scheduleDiskCheck(session);
      log("open", { sessionId: session.id, taskId, pids: limits.pids, wallTimeMs: limits.wallTimeMs });
      return session;
    },

    lookup(id: string): SessionLookup {
      if (current && current.id === id && !current.closed) return { session: current };
      const reason = closedReasons.get(id);
      if (reason !== undefined) return { status: 410, error: `session closed: ${reason}` };
      // 410 too: after a runner restart the worker must read "session gone", never confuse it with a missing file.
      return { status: 410, error: "session closed: no such session" };
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

    /** Registers a file transfer's handler; close aborts it (destroys the request) and waits for the handler. */
    trackTransfer<T>(session: Session, req: IncomingMessage, handler: Promise<T>): Promise<T> {
      const live = session as LiveSession;
      const done = handler.then(
        () => undefined,
        () => undefined,
      );
      live.transfers.set(req, done);
      void done.then(() => live.transfers.delete(req));
      return handler;
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
