import { existsSync, mkdirSync, mkdtempSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { prepareClaudeSandboxRoot } from "../src/planner/claude-sandbox.ts";

const logger = createLogger({}, { write: () => {} });

describe("Claude sandbox root", () => {
  it("creates a missing root privately and removes only sandboxes older than a session can live", () => {
    const base = mkdtempSync(join(tmpdir(), "studix-sandbox-test-"));
    const root = join(base, "claude");
    expect(prepareClaudeSandboxRoot(root, 60_000, logger)).toBe(root);
    expect(statSync(root).mode & 0o777).toBe(0o700);

    const now = Date.now();
    for (const name of ["studix-claude-old", "studix-claude-live", "unrelated"]) mkdirSync(join(root, name));
    const old = new Date(now - 120_000);
    utimesSync(join(root, "studix-claude-old"), old, old);
    utimesSync(join(root, "unrelated"), old, old);

    prepareClaudeSandboxRoot(root, 60_000, logger, now);
    expect(existsSync(join(root, "studix-claude-old"))).toBe(false);
    expect(existsSync(join(root, "studix-claude-live"))).toBe(true);
    expect(existsSync(join(root, "unrelated"))).toBe(true);
  });
});
