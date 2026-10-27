// Adapted from motion-mcp packages/hyperframes-adapter/src/render.ts @ 408ceccd (MIT, Copyright (c) 2026 Digitop).
import type { RenderConfigInput } from "@hyperframes/producer";
import { type Logger, StudixError } from "@studix/shared";

export interface ProducerRenderInput {
  projectDir: string;
  outputPath: string;
  fps: number;
  quality: "draft" | "standard" | "high";
  crf: number;
  workers?: number;
  logger: Logger;
  signal?: AbortSignal;
  /** Producer progress, 0..1. */
  onProgress: (progress: number, stage: string) => void;
}

type ProducerModule = typeof import("@hyperframes/producer");
type ConsoleMethod = "log" | "info" | "debug";

let consoleRedirects = 0;
const originalConsole: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> = {};

/**
 * The producer's browser and capture layers print progress with console.log, i.e. to stdout. Stdout is a
 * protocol channel for stdio MCP servers, so while a render runs, stdout-bound console output is routed to
 * the logger at debug level. Reference-counted so overlapping renders restore the console only once.
 */
async function withConsoleOnLogger<T>(log: Logger, fn: () => Promise<T>): Promise<T> {
  const methods: ConsoleMethod[] = ["log", "info", "debug"];
  if (consoleRedirects++ === 0) {
    for (const m of methods) {
      originalConsole[m] = console[m];
      console[m] = (...args: unknown[]) =>
        log.debug(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    }
  }
  try {
    return await fn();
  } finally {
    if (--consoleRedirects === 0) {
      for (const m of methods) {
        const orig = originalConsole[m];
        if (orig) console[m] = orig;
      }
    }
  }
}

let producerPromise: Promise<ProducerModule> | undefined;

/** Lazy import: the producer pulls in Puppeteer, which only the worker role should pay for. */
function loadProducer(): Promise<ProducerModule> {
  producerPromise ??= import("@hyperframes/producer").catch((err: unknown) => {
    producerPromise = undefined;
    throw new StudixError("UNAVAILABLE", "The HyperFrames producer could not be loaded", {
      cause: err,
      retryable: false,
    });
  });
  return producerPromise;
}

/** Capture a compiled project to an H.264 MP4 with the in-process HyperFrames producer. */
export async function renderWithProducer(input: ProducerRenderInput): Promise<{ warnings: string[] }> {
  const producer = await loadProducer();
  const config: RenderConfigInput = {
    fps: input.fps,
    quality: input.quality,
    format: "mp4",
    entryFile: "index.html",
    strictness: "best-effort",
    // Compositions are SDR by construction; skipping HDR probing keeps the output H.264.
    hdrMode: "force-sdr",
    crf: input.crf,
    logger: input.logger,
    ...(input.workers ? { workers: input.workers } : {}),
  };
  const job = producer.createRenderJob(config);
  try {
    await withConsoleOnLogger(input.logger, () =>
      producer.executeRenderJob(
        job,
        input.projectDir,
        input.outputPath,
        (j) => input.onProgress(Math.min(1, Math.max(0, j.progress / 100)), j.currentStage),
        input.signal,
      ),
    );
  } catch (err) {
    if (err instanceof producer.RenderCancelledError || input.signal?.aborted) {
      throw new StudixError("CANCELLED", "Render cancelled", { cause: err });
    }
    throw new StudixError(
      "INTERNAL",
      `HyperFrames render failed: ${job.error ?? (err instanceof Error ? err.message : String(err))}`,
      {
        cause: err,
        details: { stage: job.failedStage ?? job.currentStage },
        suggestedAction: "Check that chrome-headless-shell and FFmpeg are installed on the worker.",
      },
    );
  }
  if (job.status === "failed") {
    throw new StudixError("INTERNAL", `HyperFrames render failed: ${job.error ?? "unknown error"}`, {
      details: { stage: job.failedStage ?? job.currentStage },
    });
  }
  return { warnings: job.warnings.map((w) => w.message ?? String(w.code ?? "render warning")) };
}
