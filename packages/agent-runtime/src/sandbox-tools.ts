import { posix } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SANDBOX_WORK_DIR, type SandboxSession } from "./sandbox-docker.ts";

/** Tool names a task may ask for; each one runs inside the task's sandbox. */
export const SANDBOX_TOOL_NAMES = ["bash", "read", "write", "edit", "ls"] as const;
export type SandboxToolName = (typeof SANDBOX_TOOL_NAMES)[number];

export function isSandboxTool(name: string): name is SandboxToolName {
  return (SANDBOX_TOOL_NAMES as readonly string[]).includes(name);
}

/** Every path is resolved inside the container; the host filesystem is never touched by a tool. */
function containerPath(path: string): string {
  // On a Windows worker Pi resolves paths with win32 rules first (`/work/a` -> `D:\work\a`): map them back.
  const unixLike = /^[A-Za-z]:[\\/]/.test(path) ? path.slice(2).replaceAll("\\", "/") : path;
  return posix.resolve(SANDBOX_WORK_DIR, unixLike);
}

/**
 * Pi's own tool definitions (same schemas, prompts and truncation) with their file and shell operations
 * delegated to the sandbox. Registered as custom tools, they replace the built-ins of the same name.
 */
export function createSandboxToolDefinitions(
  sandbox: SandboxSession,
  names: readonly SandboxToolName[],
): ToolDefinition[] {
  const readFile = async (path: string) => sandbox.run(["cat", "--", containerPath(path)]);
  const test = async (flag: string, path: string) => {
    await sandbox.run(["test", flag, containerPath(path)]);
  };
  const writeFile = async (path: string, content: string) => {
    const target = containerPath(path);
    await sandbox.run(["mkdir", "-p", posix.dirname(target)]);
    await sandbox.run(["sh", "-c", 'cat > "$1"', "sh", target], { stdin: content });
  };
  const all: Record<SandboxToolName, () => ToolDefinition> = {
    bash: () =>
      createBashToolDefinition(SANDBOX_WORK_DIR, {
        operations: {
          exec: (command, cwd, options) =>
            sandbox.exec(command, {
              cwd: containerPath(cwd),
              onData: options.onData,
              ...(options.signal ? { signal: options.signal } : {}),
              ...(options.timeout ? { timeoutSeconds: options.timeout } : {}),
            }),
        },
      }) as unknown as ToolDefinition,
    read: () =>
      createReadToolDefinition(SANDBOX_WORK_DIR, {
        // Images would be resized on the host; the sandbox returns them as files to read with bash instead.
        autoResizeImages: false,
        operations: { readFile, access: (p) => test("-r", p) },
      }) as unknown as ToolDefinition,
    write: () =>
      createWriteToolDefinition(SANDBOX_WORK_DIR, {
        operations: {
          writeFile,
          mkdir: async (dir) => {
            await sandbox.run(["mkdir", "-p", containerPath(dir)]);
          },
        },
      }) as unknown as ToolDefinition,
    edit: () =>
      createEditToolDefinition(SANDBOX_WORK_DIR, {
        operations: {
          readFile,
          writeFile,
          access: async (p) => {
            await test("-r", p);
            await test("-w", p);
          },
        },
      }) as unknown as ToolDefinition,
    ls: () =>
      createLsToolDefinition(SANDBOX_WORK_DIR, {
        operations: {
          exists: (p) =>
            test("-e", p).then(
              () => true,
              () => false,
            ),
          stat: async (p) => {
            const isDir = await test("-d", p).then(
              () => true,
              async () => {
                await test("-e", p);
                return false;
              },
            );
            return { isDirectory: () => isDir };
          },
          readdir: async (p) =>
            (await sandbox.run(["ls", "-A1", "--", containerPath(p)]))
              .toString("utf8")
              .split("\n")
              .filter(Boolean),
        },
      }) as unknown as ToolDefinition,
  };
  return names.map((name) => all[name]());
}
