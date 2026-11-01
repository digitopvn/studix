import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preflightClaudeRuntime } from "../src/claude-preflight.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeBinary(mode = 0o755): string {
  const dir = mkdtempSync(join(tmpdir(), "studix-preflight-"));
  dirs.push(dir);
  const path = join(dir, "claude");
  writeFileSync(path, "#!/bin/sh\necho 1.2.3\n");
  chmodSync(path, mode);
  return path;
}

// The fake binary is a shell script with POSIX mode bits; Windows can neither run it nor honour the bits.
const posix = process.platform !== "win32";

describe("preflightClaudeRuntime", () => {
  it.runIf(posix)("accepts a binary that launches and reports its version", async () => {
    const executable = fakeBinary();
    expect(await preflightClaudeRuntime({ pathToClaudeCodeExecutable: executable })).toEqual({
      ok: true,
      executable,
      version: "1.2.3",
    });
  });

  it("rejects a configured executable that does not exist", async () => {
    const result = await preflightClaudeRuntime({ pathToClaudeCodeExecutable: "/nonexistent/claude" });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("does not exist") });
  });

  it.runIf(posix)("rejects a file that is not executable", async () => {
    const result = await preflightClaudeRuntime({ pathToClaudeCodeExecutable: fakeBinary(0o644) });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("not executable") });
  });

  it("rejects a binary that exists but fails to launch", async () => {
    const result = await preflightClaudeRuntime({
      pathToClaudeCodeExecutable: fakeBinary(),
      run: async () => {
        throw new Error("spawn ENOENT (musl loader missing)");
      },
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("failed to launch") });
  });

  it("reports the platform when no bundled binary exists, trying the libc variants in SDK order", async () => {
    const tried: string[] = [];
    const result = await preflightClaudeRuntime({
      platform: "linux",
      arch: "riscv64",
      preferMusl: false,
      resolveBundled: (candidate) => {
        tried.push(candidate);
        return undefined;
      },
    });
    expect(tried).toEqual([
      "@anthropic-ai/claude-agent-sdk-linux-riscv64/claude",
      "@anthropic-ai/claude-agent-sdk-linux-riscv64-musl/claude",
    ]);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("linux-riscv64") });
  });

  it("finds the SDK's bundled binary for this host", async () => {
    const result = await preflightClaudeRuntime();
    // Hosts without a shipped binary report ok:false; either way the check must not throw.
    expect(typeof result.ok).toBe("boolean");
    if (result.ok) expect(result.version).toMatch(/\d/);
  });
});
