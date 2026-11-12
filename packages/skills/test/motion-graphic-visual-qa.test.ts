import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StageContext, StageDefinition } from "@studix/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MG_VISUAL_QA_STAGE, motionGraphicRenderStage } from "../src/index.ts";

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
});
