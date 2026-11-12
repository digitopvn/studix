import type { AgentTraceReader, StorageAdapter } from "@studix/core";
import { StudixError } from "@studix/shared";

/** A trace bigger than this is refused rather than buffered (the worker caps its traces well below it). */
const MAX_TRACE_BYTES = 8 * 1024 * 1024;

/** Reads agent session traces from the object storage the worker writes them to; a missing one is undefined. */
export function createAgentTraceReader(storage: Pick<StorageAdapter, "get">): AgentTraceReader {
  return {
    async read(ctx, key) {
      let object: Awaited<ReturnType<StorageAdapter["get"]>>;
      try {
        object = await storage.get(ctx, key);
      } catch (err) {
        if (err instanceof StudixError && err.code === "NOT_FOUND") return undefined;
        throw err;
      }
      if (object.bytes > MAX_TRACE_BYTES) {
        await object.body.cancel();
        throw new StudixError("VALIDATION", "Agent trace is too large to read", { details: { key } });
      }
      return new Response(object.body).text();
    },
  };
}
