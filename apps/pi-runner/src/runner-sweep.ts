/*
 * Cleanup between sessions: kill what a session left running, wipe every writable path, and measure the disk a
 * live session holds. Nothing of one session may reach the next one, including a process that escaped its
 * process group with setsid (the /proc sweep) or a directory it made unreadable (the chmod retry of the wipe).
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function signal(pid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

/** SIGKILL a whole process group (a command is spawned detached, so its pid is its group id). */
export function killGroup(pgid: number): void {
  if (!signal(-pgid, "SIGKILL")) signal(pgid, "SIGKILL");
}

async function listPids(): Promise<number[]> {
  const entries = await readdir("/proc").catch(() => [] as string[]);
  return entries.filter((name) => /^\d+$/.test(name)).map(Number);
}

/**
 * Linux only: SIGKILL every process of the container except the runner and pid 1 (tini; killing it would end the
 * container). kill(-1) reaches every process this uid may signal in the PID namespace in one call, so a fork
 * racing the sweep is caught by the next round. Repeats until none is left (killed ones reaped by tini) or the
 * budget runs out. Returns false when processes survive; the caller must not hand the runner to a new session.
 */
export async function sweepProcesses(budgetMs = 10_000): Promise<boolean> {
  if (process.platform !== "linux") return true;
  const spared = new Set([1, process.pid, process.ppid]);
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const alive = (await listPids()).filter((pid) => !spared.has(pid) && signal(pid, 0));
    if (alive.length === 0) return true;
    if (Date.now() > deadline) return false;
    signal(-1, "SIGKILL");
    for (const pid of alive) signal(pid, "SIGKILL");
    await delay(50);
  }
}

function run(command: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env.PATH ?? "" },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", () => resolve({ code: null, stdout }));
    child.once("close", (code) => resolve({ code, stdout }));
  });
}

/** Empties a directory (creating it when missing) without removing the directory itself, which may be a mount. */
export async function emptyDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const name of entries) {
    const target = join(dir, name);
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      // A session can chmod a directory to 000; restore owner access, then retry once.
      await run("chmod", ["-R", "u+rwx", target]);
      await rm(target, { recursive: true, force: true, maxRetries: 2 });
    }
  }
}

/** Empties a scratch path such as /tmp only if it exists; a missing one is not an error. */
export async function emptyIfExists(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => null);
  if (entries === null) return;
  await emptyDir(dir);
}

/**
 * Bytes held under the given paths, from `du -sk` (one process, no JS-side tree walk). A directory the session
 * made unreadable is not counted; that gap is the accepted bound of this cheap check (the wipe still removes it).
 * Returns null when du produced no figure at all.
 */
export async function measureDiskBytes(paths: readonly string[]): Promise<number | null> {
  if (paths.length === 0) return 0;
  const { stdout } = await run("du", ["-sk", ...paths]);
  let total = 0;
  let seen = false;
  for (const line of stdout.split("\n")) {
    const kb = Number.parseInt(line, 10);
    if (Number.isFinite(kb)) {
      total += kb * 1024;
      seen = true;
    }
  }
  return seen ? total : null;
}
