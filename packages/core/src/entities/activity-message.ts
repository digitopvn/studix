import { redact, redactHeaderLines } from "@studix/shared";

/** Longest message derived from an event's attributes; log tails show it instead of the bare event name. */
const MAX_DERIVED_CHARS = 200;
const TEXT_KEYS = ["message", "error", "reason", "summary"] as const;

function text(value: unknown): string | undefined {
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string"
        ? (value as { message: string }).message
        : undefined;
  // Header lines are masked while they still start a line; a prefix added later would hide them.
  return raw ? redactHeaderLines(raw).trim() || undefined : undefined;
}

function short(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DERIVED_CHARS ? `${flat.slice(0, MAX_DERIVED_CHARS)}…` : flat;
}

function describe(attributes: Record<string, unknown>): string | undefined {
  const type = attributes.type;
  const name = typeof attributes.name === "string" ? attributes.name : undefined;
  switch (type) {
    case "message": {
      const delta = text(attributes.delta);
      return delta ? `agent: ${delta}` : undefined;
    }
    case "reasoning":
      return "agent reasoning";
    case "tool_start":
      return name ? `tool ${name} started` : undefined;
    case "tool_end":
      return name ? `tool ${name} ${attributes.ok === false ? "failed" : "finished"}` : undefined;
    case "status": {
      const status = typeof attributes.status === "string" ? attributes.status : undefined;
      if (!status) return undefined;
      const runtime = typeof attributes.runtime === "string" ? ` (${attributes.runtime})` : "";
      const error = text(attributes.error);
      return `agent ${status}${runtime}${error ? `: ${error}` : ""}`;
    }
    case "artifact":
      return name ? `artifact ${name}` : undefined;
    case "usage":
      return typeof attributes.turns === "number"
        ? `agent usage: ${attributes.turns} turns, ${String(attributes.inputTokens)} in / ${String(attributes.outputTokens)} out tokens`
        : undefined;
    default:
      for (const key of TEXT_KEYS) {
        const found = text(attributes[key]);
        if (found) return found;
      }
      return undefined;
  }
}

/**
 * A short, redacted one-line message for an activity event written without one, taken from its attributes
 * (agent stream events carry their text there). Undefined when the attributes say nothing readable, so the
 * event keeps no message rather than a made-up one.
 */
export function deriveActivityMessage(attributes: Record<string, unknown>): string | undefined {
  const summary = describe(attributes);
  // Header lines go first: flattening newlines would hide them from the line-anchored rule.
  return summary ? short(redactHeaderLines(redact(redactHeaderLines(summary)))) : undefined;
}
