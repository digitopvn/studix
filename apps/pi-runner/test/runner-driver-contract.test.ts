/*
 * Contract test: the worker's real sidecar driver (packages/agent-runtime) against the real runner server, so a
 * change on either side of sandbox-runner-protocol.ts that breaks the other fails here, not in staging.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSidecarSandboxDriver } from "../../../packages/agent-runtime/src/sandbox-sidecar.ts";
import { PIDS, startTestRunner, TOKEN } from "./runner-test-client.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup() {
  const runner = await startTestRunner();
  cleanups.push(() => runner.stop());
  const host = await mkdtemp(join(tmpdir(), "pi-runner-host-"));
  cleanups.push(() => rm(host, { recursive: true, force: true }));
  const driver = createSidecarSandboxDriver({ runners: [{ url: runner.url, token: TOKEN }] });
  const open = () =>
    driver.open({
      taskId: "contract",
      env: { DEMO_VENDOR_KEY: "vendor-value" },
      limits: { cpus: 1, memoryMb: 512, pids: PIDS, wallTimeMs: 60_000 },
      signal: new AbortController().signal,
    });
  return { runner, host, open };
}

describe("sidecar driver against the real runner", () => {
  it("runs commands, moves files both ways and wipes the session on close", async () => {
    const { runner, host, open } = await setup();
    const session = await open();

    let streamed = "";
    const { exitCode } = await session.exec('echo "$DEMO_VENDOR_KEY"; cat; echo oops >&2; exit 3', {
      stdin: "from-stdin\n",
      onData: (chunk) => {
        streamed += chunk.toString("utf8");
      },
    });
    expect(exitCode).toBe(3);
    expect(streamed).toContain("vendor-value");
    expect(streamed).toContain("from-stdin");
    expect(streamed).toContain("oops");

    const input = join(host, "in.txt");
    await writeFile(input, "payload");
    const inside = join(runner.work, "out", "copy.txt");
    await session.copyIn(input, inside);
    expect((await session.run(["cat", inside])).toString("utf8")).toBe("payload");
    await expect(session.run(["sh", "-c", "exit 7"])).rejects.toThrow();

    const back = join(host, "back.txt");
    await session.copyOut(inside, back);
    expect(await readFile(back, "utf8")).toBe("payload");

    // An agent writing a whole file through a heredoc: far past Node's default 16 KiB header limit.
    const big = "x".repeat(60_000);
    const bigFile = join(runner.work, "big.txt");
    expect((await session.exec(`cat > '${bigFile}' <<'EOF'\n${big}\nEOF`)).exitCode).toBe(0);
    expect((await session.run(["wc", "-c", bigFile])).toString("utf8")).toContain(String(big.length + 1));

    await session.close();
    await expect(session.exec("true")).rejects.toThrow(/stopped/i);

    // The runner is free again and the previous session's files are gone.
    const second = await open();
    const { exitCode: gone } = await second.exec(`test ! -e '${inside}'`);
    expect(gone).toBe(0);
    await second.close();
  });
});
