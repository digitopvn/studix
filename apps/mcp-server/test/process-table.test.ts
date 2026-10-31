import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { descendants, listProcesses, parseCimCsv, parsePsTable } from "./e2e-video-harness.js";

describe("process table helpers used by the e2e harness", () => {
  it("parses POSIX ps output", () => {
    expect(parsePsTable("    1     0\n  230     1\n")).toEqual([
      { pid: 1, ppid: 0 },
      { pid: 230, ppid: 1 },
    ]);
  });

  it("parses Windows CIM CSV output with CRLF and a header", () => {
    const csv = '"ProcessId","ParentProcessId","Created"\r\n"4","0","10"\r\n"812","4","20"\r\n';
    expect(parseCimCsv(csv)).toEqual([
      { pid: 4, ppid: 0, created: 10 },
      { pid: 812, ppid: 4, created: 20 },
    ]);
  });

  it("lists this process and finds a spawned descendant on the current platform", async () => {
    expect(listProcesses().some((row) => row.pid === process.pid)).toBe(true);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      expect(child.pid).toBeDefined();
      expect(descendants(process.pid)).toContain(child.pid);
    } finally {
      child.kill();
    }
  });
});
