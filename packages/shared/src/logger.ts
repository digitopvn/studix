import { redact, redactDeep } from "./redact.ts";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Line sink; defaults to stderr so stdout stays free for protocol traffic (stdio MCP). */
  write?: (line: string) => void;
  now?: () => Date;
}

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

/** JSON-lines logger that redacts the message and every field before writing. */
export function createLogger(bindings: LogFields = {}, options: LoggerOptions = {}): Logger {
  const envLevel = process.env.LOG_LEVEL;
  const level: LogLevel = options.level ?? (isLogLevel(envLevel) ? envLevel : "info");
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const safeBindings = redactDeep(bindings);

  const emit = (lvl: LogLevel, msg: string, fields?: LogFields) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const line = {
      ts: now().toISOString(),
      level: lvl,
      msg: redact(msg),
      ...safeBindings,
      ...(fields ? redactDeep(fields) : {}),
    };
    try {
      write(JSON.stringify(line));
    } catch {
      // Unserializable fields (e.g. BigInt) must never crash the caller; log a degraded line instead.
      write(JSON.stringify({ ts: line.ts, level: lvl, msg: line.msg, logError: "unserializable fields" }));
    }
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (b) => createLogger({ ...bindings, ...b }, { level, write, now }),
  };
}
