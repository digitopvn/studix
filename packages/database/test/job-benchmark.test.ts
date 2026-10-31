import { describe, expect, it } from "vitest";
import {
  computeBenchmark,
  formatBenchmarkMarkdown,
  isQaStage,
  percentile,
} from "../src/benchmark/job-benchmark.ts";
import { benchmarkRows } from "./fixtures/benchmark-rows.ts";

const IDS = ["job_mkt", "job_anime", "job_fail", "job_run", "job_cancel", "job_missing"];

describe("job benchmark", () => {
  const report = computeBenchmark(benchmarkRows, IDS);
  const job = (id: string) => report.jobs.find((j) => j.jobId === id)!;

  it("keeps the requested order and reports ids the database does not hold", () => {
    expect(report.jobs.map((j) => j.jobId)).toEqual(IDS.slice(0, 5));
    expect(report.missingJobIds).toEqual(["job_missing"]);
  });

  it("measures time to the first stored render, with and without gate waits", () => {
    expect(job("job_mkt").timeToPreviewMs).toBe(300_000);
    // Three creative gates waited 60 + 60 + 30 s before the first ad was stored.
    expect(job("job_mkt").timeToPreviewExcludingGatesMs).toBe(150_000);
    expect(job("job_anime").timeToPreviewMs).toBe(900_000);
    expect(job("job_anime").timeToPreviewExcludingGatesMs).toBe(800_000);
    expect(job("job_fail").timeToPreviewMs).toBeNull();
  });

  it("prices video minutes and agent seconds from the usage ledger and stored renders only", () => {
    const mkt = job("job_mkt");
    expect(mkt.videoSeconds).toBe(60);
    expect(mkt.costCents).toBe(690.5);
    expect(mkt.costPerVideoMinuteCents).toBe(690.5);
    expect(mkt.agentCostPerVideoSecondCents).toBe(1.5);
    expect(job("job_anime").costPerVideoMinuteCents).toBe(1380);
    expect(job("job_anime").agentCostPerVideoSecondCents).toBe(3);
    expect(job("job_fail").costPerVideoMinuteCents).toBeNull();
  });

  it("collects QA hard gate runs and their failure messages", () => {
    expect(job("job_mkt")).toMatchObject({ qaRuns: 2, qaPassed: 1 });
    expect(job("job_mkt").qaFailures).toEqual([
      { stage: "marketing-video.qa", attempt: 1, messages: ["integrated loudness -9 LUFS"] },
    ]);
    expect(job("job_fail").qaFailures[0]!.messages).toEqual(["QA hard gate failed: black frames"]);
  });

  it("counts stage cache hits, provider failures, reused assets and gates", () => {
    expect(job("job_mkt")).toMatchObject({
      stageAttempts: 4,
      failedStageAttempts: 1,
      cachedStages: 1,
      providerExecutions: 3,
      failedProviderExecutions: 1,
      assetsReferenced: 4,
      assetsReused: 1,
      interventions: 3,
      gateRejections: 1,
      interventionsByAction: { "creative.gate": 3 },
    });
  });

  it("summarizes the job set", () => {
    expect(report.summary).toEqual({
      jobs: 5,
      finishedJobs: 3,
      succeededJobs: 2,
      unfinishedJobs: 1,
      successRate: 2 / 3,
      timeToPreviewP50Ms: 300_000,
      timeToPreviewP95Ms: 900_000,
      timeToPreviewExcludingGatesP50Ms: 150_000,
      videoSeconds: 75,
      costCents: 1085.5,
      costByKind: {
        "media.generation": 950,
        "agent.run": 135,
        "provider.decision": 0.5,
        "render.seconds": 0,
      },
      costPerVideoMinuteCents: 868.4,
      agentCostCents: 135,
      agentCostPerVideoSecondCents: 1.8,
      // Anime: one patch version and one storyboard sent back; marketing: one rejected gate.
      revisionRounds: 3,
      assetsReferenced: 6,
      assetsReused: 1,
      assetReuseRate: 1 / 6,
      stageAttempts: 6,
      cachedStages: 1,
      qaRuns: 4,
      qaPassed: 2,
      qaFailures: 2,
      interventions: 6,
      interventionsByAction: { "creative.gate": 3, "agent.overrun": 1, "storyboard.review": 2 },
    });
  });

  it("returns null metrics instead of zeros when nothing was measured", () => {
    const empty = computeBenchmark(benchmarkRows, ["job_missing"]);
    expect(empty.summary).toMatchObject({
      jobs: 0,
      successRate: null,
      timeToPreviewP50Ms: null,
      costPerVideoMinuteCents: null,
      assetReuseRate: null,
    });
  });

  it("formats markdown tables for the metrics doc", () => {
    const md = formatBenchmarkMarkdown(report);
    expect(md).toContain("| Success rate | 66.7% |");
    expect(md).toContain("| Cost per video minute | 868.4000 ¢ |");
    expect(md).toContain("| `job_mkt` | marketing-video | succeeded | 300.0 s | 60.0 s |");
    expect(md).toContain("- `job_mkt` marketing-video.qa (attempt 1): integrated loudness -9 LUFS");
    expect(md).toContain("Missing jobs: `job_missing`");
  });
});

describe("benchmark helpers", () => {
  it("uses nearest-rank percentiles", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([3, 1, 2], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
  });

  it("recognizes QA hard gate stages", () => {
    expect(isQaStage("marketing-video.qa")).toBe(true);
    expect(isQaStage("anime.qa")).toBe(true);
    expect(isQaStage("qa_check")).toBe(true);
    expect(isQaStage("marketing-video.qa_review")).toBe(false);
    expect(isQaStage("render")).toBe(false);
  });
});
