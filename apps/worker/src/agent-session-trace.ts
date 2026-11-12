import type { StorageAdapter, TenantContext } from "@studix/core";
import type { Clock, Logger } from "@studix/shared";

/** Events kept per run; later ones are dropped and a `truncated` line says so. */
const MAX_EVENTS = 5_000;
/** Bytes kept per run, for the same reason. */
const MAX_BYTES = 4 * 1024 * 1024;
/** Consecutive text or reasoning deltas are merged into one line until it holds about this many chars. */
const MAX_MERGED_DELTA_CHARS = 2_048;

/**
 * One agent run's session trace (`agentTraceKey` in @studix/core): every event as a JSONL line with `seq` and
 * `ts`, stored in object storage on each heartbeat and at the end, so a hung run is readable while it hangs.
 * Cumulative `usage` reports become per-turn `turn` lines (tokens, cost, latency); `tool_end` gets
 * `durationMs`. Callers pass events already redacted and compacted (the agent event sink does).
 */
export interface AgentSessionTrace {
  append(event: Record<string, unknown>): void;
  /** Adds a heartbeat line (`idleMs` since the last real event) and stores the trace if it changed. */
  heartbeat(): Promise<void>;
  /** Stores the final trace; failures are logged, never thrown. */
  close(): Promise<void>;
}

interface Usage {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const round = (value: number) => Math.round(value * 10_000) / 10_000;

export function createAgentSessionTrace(deps: {
  storage: Pick<StorageAdapter, "put">;
  ctx: TenantContext;
  key: string;
  clock: Clock;
  logger: Logger;
  /** Called on each real event (not heartbeats), to mark the stage active. */
  onActivity?: () => void;
  maxEvents?: number;
  maxBytes?: number;
}): AgentSessionTrace {
  const maxEvents = deps.maxEvents ?? MAX_EVENTS;
  const maxBytes = deps.maxBytes ?? MAX_BYTES;
  const lines: string[] = [];
  let bytes = 0;
  let seq = 0;
  let dropped = 0;
  let dirty = false;
  let uploads: Promise<void> = Promise.resolve();
  const started = deps.clock.now().getTime();
  let lastEventAt = started;
  let lastTurnAt = started;
  let usage: Usage = { turns: 0, inputTokens: 0, outputTokens: 0, costCents: 0 };
  const toolStarts = new Map<string, number>();
  /** The last line when it is a text or reasoning delta that a following delta of its type may extend. */
  let open:
    | { type: string; seq: number; ts: string; delta: string; event: Record<string, unknown> }
    | undefined;

  /**
   * A streaming model sends hundreds of small deltas; the trace keeps one line per contiguous block (cut at
   * about 2 KB), so it stays readable and far from its event cap.
   */
  const merged = (event: Record<string, unknown>): boolean => {
    const isDelta =
      (event.type === "message" || event.type === "reasoning") && typeof event.delta === "string";
    if (!isDelta) {
      open = undefined;
      return false;
    }
    const delta = event.delta as string;
    if (
      dropped === 0 &&
      open &&
      open.type === event.type &&
      open.delta.length + delta.length <= MAX_MERGED_DELTA_CHARS
    ) {
      const old = lines[lines.length - 1]!;
      open.delta += delta;
      const line = JSON.stringify({ seq: open.seq, ts: open.ts, ...open.event, delta: open.delta });
      if (bytes - old.length + line.length <= maxBytes) {
        lines[lines.length - 1] = line;
        bytes += line.length - old.length;
        dirty = true;
        return true;
      }
      open.delta = open.delta.slice(0, -delta.length || undefined);
    }
    return false;
  };

  const add = (event: Record<string, unknown>, now: number) => {
    if (dropped > 0) {
      dropped++;
      return;
    }
    if (merged(event)) return;
    const line = JSON.stringify({ seq, ts: new Date(now).toISOString(), ...event });
    if (lines.length >= maxEvents - 1 || bytes + line.length > maxBytes) {
      dropped = 1;
      lines.push(JSON.stringify({ seq, ts: new Date(now).toISOString(), type: "truncated" }));
      seq++;
      dirty = true;
      return;
    }
    lines.push(line);
    bytes += line.length + 1;
    if ((event.type === "message" || event.type === "reasoning") && typeof event.delta === "string") {
      open = { type: event.type, seq, ts: new Date(now).toISOString(), delta: event.delta, event };
    }
    seq++;
    dirty = true;
  };

  /** Usage reports are cumulative; a turn line carries what changed since the previous one. */
  const turnOf = (event: Record<string, unknown>, now: number): Record<string, unknown> => {
    const next: Usage = {
      turns: num(event.turns),
      inputTokens: num(event.inputTokens),
      outputTokens: num(event.outputTokens),
      costCents: num(event.costCents),
    };
    const turn = {
      type: "turn",
      turn: next.turns,
      ...(typeof event.model === "string" ? { model: event.model } : {}),
      inputTokens: Math.max(0, next.inputTokens - usage.inputTokens),
      outputTokens: Math.max(0, next.outputTokens - usage.outputTokens),
      costCents: round(Math.max(0, next.costCents - usage.costCents)),
      latencyMs: now - lastTurnAt,
      total: next,
    };
    usage = next;
    lastTurnAt = now;
    return turn;
  };

  const store = () => {
    if (!dirty) return uploads;
    dirty = false;
    const body = new TextEncoder().encode(`${lines.join("\n")}\n`);
    uploads = uploads.then(() =>
      deps.storage.put(deps.ctx, deps.key, body, { contentType: "application/x-ndjson" }).then(
        () => undefined,
        (err: unknown) => {
          dirty = true;
          deps.logger.warn("agent trace not stored", { key: deps.key, error: String(err) });
        },
      ),
    );
    return uploads;
  };

  return {
    append(event) {
      const now = deps.clock.now().getTime();
      lastEventAt = now;
      deps.onActivity?.();
      if (event.type === "usage") {
        add(turnOf(event, now), now);
        return;
      }
      if (event.type === "tool_start" && typeof event.id === "string") toolStarts.set(event.id, now);
      if (event.type === "tool_end" && typeof event.id === "string") {
        const at = toolStarts.get(event.id);
        toolStarts.delete(event.id);
        // A turn's latency is the model's time: counted from the last tool result, not across the tool.
        lastTurnAt = now;
        add({ ...event, ...(at !== undefined ? { durationMs: now - at } : {}) }, now);
        return;
      }
      add(event, now);
    },
    heartbeat() {
      const now = deps.clock.now().getTime();
      add({ type: "heartbeat", idleMs: now - lastEventAt, ...(dropped ? { dropped } : {}) }, now);
      return store();
    },
    close() {
      if (dropped > 1) {
        // The count of what the cap dropped, so a reader knows how much is missing.
        lines.push(
          JSON.stringify({
            seq,
            ts: deps.clock.now().toISOString(),
            type: "truncated",
            dropped: dropped - 1,
          }),
        );
        seq++;
        dirty = true;
      }
      return store();
    },
  };
}
