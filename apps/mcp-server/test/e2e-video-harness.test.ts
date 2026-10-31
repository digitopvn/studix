import { describe, expect, it } from "vitest";
import { descendantsFrom, parseProcessTable } from "./e2e-video-harness.ts";

describe("e2e video harness process table", () => {
  it("parses POSIX and Windows line endings and skips malformed lines", () => {
    const table = parseProcessTable("  10 1\r\n11 10\n\nPID PPID\n12 10\n13 11\r\n");
    expect(descendantsFrom(table, 10).sort((a, b) => a - b)).toEqual([11, 12, 13]);
    expect(descendantsFrom(table, 99)).toEqual([]);
  });
});
