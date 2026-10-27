import { describe, expect, it } from "vitest";
import { createLogger } from "../src/index.ts";

function capture() {
  const lines: Record<string, unknown>[] = [];
  return { lines, write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) };
}

describe("createLogger", () => {
  it("writes redacted JSON lines with bindings and respects the level", () => {
    const sink = capture();
    const log = createLogger(
      { service: "test" },
      { level: "info", write: sink.write, now: () => new Date(0) },
    );
    log.debug("hidden");
    log.info("connect postgres://u:secretpw@h/db", { token: "abc", jobId: "job_1" });
    expect(sink.lines).toEqual([
      {
        ts: "1970-01-01T00:00:00.000Z",
        level: "info",
        msg: "connect postgres://u:[redacted]@h/db",
        service: "test",
        token: "[redacted]",
        jobId: "job_1",
      },
    ]);
  });

  it("children inherit bindings and never throw on unserializable fields", () => {
    const sink = capture();
    const log = createLogger({ a: 1 }, { level: "debug", write: sink.write }).child({ b: 2 });
    log.warn("w");
    log.error("bigint", { n: 10n });
    expect(sink.lines[0]).toMatchObject({ level: "warn", a: 1, b: 2 });
    expect(sink.lines[1]).toMatchObject({ level: "error", logError: "unserializable fields" });
  });
});
