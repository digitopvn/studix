import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createClaudeSdkTransport } from "../src/index.ts";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    rmSync: () => {
      throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
    },
  };
});

describe("claude SDK transport cleanup", async () => {
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const sandboxRoot = fs.mkdtempSync(join(tmpdir(), "studix-claude-cleanup-"));
  afterAll(() => fs.rmSync(sandboxRoot, { recursive: true, force: true }));

  it("resolves closed and does not throw when the sandbox cannot be removed", async () => {
    const transport = createClaudeSdkTransport({ sandboxRoot, query: () => (async function* () {})() });
    const session = transport.start({
      model: "claude-sonnet-5-5",
      instructions: "Plan",
      input: {},
      allowedTools: [],
      maxTurns: 1,
      maxBudgetUsd: 0.1,
      credential: "sk-ant-cleanup-test",
      canUseTool: async () => false,
    });
    for await (const _ of session.events) {
      // drain
    }
    expect(() => session.interrupt()).not.toThrow();
    await expect(session.closed).resolves.toBeUndefined();
  });
});
