import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStatus } from "@studix/core";
import { withTestDatabase } from "@studix/database/testing";
import { describe, expect, it } from "vitest";
import { sweepWorkDir } from "../src/work-dir-sweeper.ts";

const db = withTestDatabase();
const human = { type: "user" as const, id: "usr_reviewer" };
const HOUR = 3_600_000;
const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
};

describe("work directory sweep", () => {
  it("removes scratch of finished jobs, keeps failed ones for the retention and active ones always", async () => {
    const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
      organization: { name: "sweep", slug: "sweep" },
      workspace: { name: "Main", slug: "main" },
    });
    const ctx = {
      organizationId: organization.id,
      workspaceId: workspace.id,
      actor: { type: "user" as const, id: "usr_1", role: "owner" as const },
    };
    const { repos } = db.current;
    const workDir = mkdtempSync(join(tmpdir(), "studix-sweep-"));
    const make = async (status: string, finishedHoursAgo?: number) => {
      const { job } = await repos.queue.enqueue(ctx, { kind: "x", payload: {}, createdBy: human });
      await repos.jobs.update(ctx, job.id, {
        status: status as JobStatus,
        ...(finishedHoursAgo === undefined
          ? {}
          : { finishedAt: new Date(Date.now() - finishedHoursAgo * HOUR) }),
      });
      mkdirSync(join(workDir, job.id, "attempt-1"), { recursive: true });
      writeFileSync(join(workDir, job.id, "attempt-1", "out.bin"), "x");
      return job.id;
    };
    const succeeded = await make("succeeded", 0);
    const cancelled = await make("cancelled", 0);
    const failedFresh = await make("failed", 1);
    const failedOld = await make("failed", 30);
    const running = await make("running");
    const queued = await make("queued");
    const unknownOld = "job_00000000000000000000000000";
    mkdirSync(join(workDir, unknownOld));
    const old = new Date(Date.now() - 8 * 24 * HOUR);
    utimesSync(join(workDir, unknownOld), old, old);
    const unknownFresh = "job_00000000000000000000000001";
    mkdirSync(join(workDir, unknownFresh));
    mkdirSync(join(workDir, "claude"));

    const removed = await sweepWorkDir({
      db: db.current.db,
      workDir,
      retentionMs: 24 * HOUR,
      clock: { now: () => new Date() },
      logger,
    });

    expect(removed).toBe(4);
    const gone = [succeeded, cancelled, failedOld, unknownOld].map((id) => existsSync(join(workDir, id)));
    const kept = [failedFresh, running, queued, unknownFresh, "claude"].map((id) =>
      existsSync(join(workDir, id)),
    );
    expect(gone).toEqual([false, false, false, false]);
    expect(kept).toEqual([true, true, true, true, true]);
  });

  it("does nothing when the work directory does not exist", async () => {
    const removed = await sweepWorkDir({
      db: db.current.db,
      workDir: join(tmpdir(), "studix-sweep-missing-dir"),
      retentionMs: HOUR,
      clock: { now: () => new Date() },
      logger,
    });
    expect(removed).toBe(0);
  });
});
