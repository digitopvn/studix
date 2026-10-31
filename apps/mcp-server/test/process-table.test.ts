import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { descendants, listProcesses, parseCimCsv, parsePsTable } from "./e2e-video-harness.js";

describe("process table helpers used by the e2e harness", () => {
  it("parses POSIX ps output", () => {
    expect(parsePsTable("    1     0\n  230     1\n")).toEqual([
      [1, 0],
      [230, 1],
    ]);
  });

  it("parses Windows CIM CSV output with CRLF and a header", () => {
    const csv = '"ProcessId","ParentProcessId"\r\n"4","0"\r\n"812","4"\r\n';
    expect(parseCimCsv(csv)).toEqual([
      [4, 0],
      [812, 4],
    ]);
  });

  it("lists this process and finds a spawned descendant on the current platform", async () => {
    expect(listProcesses().some(([pid]) => pid === process.pid)).toBe(true);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 200));
      expect(descendants(process.pid)).toContain(child.pid);
    } finally {
      child.kill();
    }
  });
});
