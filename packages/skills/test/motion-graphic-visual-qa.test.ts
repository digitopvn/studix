import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StageContext, StageDefinition } from "@studix/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MG_VISUAL_QA_STAGE, motionGraphicRenderStage } from "../src/index.ts";
import { MG_STORYBOARD_LIMITS } from "../src/motion-graphic/motion-graphic-storyboard.ts";
import { MG_STILLS_CAPTURE_BUDGET_MS, repairFits } from "../src/motion-graphic/motion-graphic-visual-qa.ts";

const probe = { durationMs: 1000, width: 160, height: 90, fps: 5, videoCodec: "h264", bytes: 0 };

describe("motion-graphic render stage after the visual review", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const setup = async () => {
    dir = await mkdtemp(join(tmpdir(), "mg-vqa-"));
    const kept = { filePath: join(dir, "render-1.mp4"), mime: "video/mp4", probe };
    const engine: StageDefinition = {
      name: "render",
      estimateCostCents: () => 7,
      run: vi.fn(async () => ({
        output: { filePath: join(dir as string, "fresh.mp4"), mime: "video/mp4", probe },
      })),
    };
    const s = {
      outputs: { [MG_VISUAL_QA_STAGE]: { ir: {}, visualQa: { status: "fixed", rounds: [] }, render: kept } },
    } as unknown as StageContext;
    return { kept, engine, stage: motionGraphicRenderStage(engine), s };
  };

  it("reuses the reviewed render for free while its file exists", async () => {
    const { kept, engine, stage, s } = await setup();
    await writeFile(kept.filePath, "mp4");
    expect(await stage.estimateCostCents?.(s)).toBe(0);
    expect((await stage.run(s)).output).toEqual(kept);
    expect(engine.run).not.toHaveBeenCalled();
  });

  it("renders the reviewed IR again when the kept file is gone (the job moved to another worker)", async () => {
    const { engine, stage, s } = await setup();
    expect(await stage.estimateCostCents?.(s)).toBe(7);
    await stage.run(s);
    expect(engine.run).toHaveBeenCalledWith(s);
  });

  it("does the full render, billed, when the stills review kept no draft render", async () => {
    const { engine } = await setup();
    const stage = motionGraphicRenderStage(engine);
    const s = {
      outputs: { [MG_VISUAL_QA_STAGE]: { ir: {}, visualQa: { status: "passed", rounds: [] } } },
    } as unknown as StageContext;
    expect(await stage.estimateCostCents?.(s)).toBe(7);
    expect((await stage.run(s)).output).toMatchObject({ mime: "video/mp4" });
    expect(engine.run).toHaveBeenCalledWith(s);
  });
});

describe("visual review repair round", () => {
  const renderMs = 90_000;
  const captureMs = 80_000;
  const roomy = { renderMs, captureMs, centsLeft: 1000, renderCents: 50 };
  // The redesign (180 s cap), a re-capture with half again in hand, and the final render; no second review.
  const need = MG_STORYBOARD_LIMITS.timeoutMs + 1.5 * captureMs + renderMs;

  it("applies a fix round when the redesign, a re-capture and the final render fit", () => {
    expect(repairFits({ ...roomy, timeLeftMs: need })).toBe("fits");
  });

  it("stops when the redesign and render do not fit in the time or budget left", () => {
    expect(repairFits({ ...roomy, timeLeftMs: need - 1 })).toBe("no-time");
    // A quick first capture still reserves the capture cap for the re-capture.
    const quick = MG_STORYBOARD_LIMITS.timeoutMs + MG_STILLS_CAPTURE_BUDGET_MS + renderMs;
    expect(repairFits({ ...roomy, captureMs: 1000, timeLeftMs: quick - 1 })).toBe("no-time");
    expect(repairFits({ ...roomy, captureMs: 1000, timeLeftMs: quick })).toBe("fits");
    expect(repairFits({ ...roomy, timeLeftMs: Number.POSITIVE_INFINITY, centsLeft: 60 })).toBe("no-budget");
  });
});
