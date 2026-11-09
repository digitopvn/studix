/* Validation of POST /v1/sessions: the body is untrusted until every field has been checked here. */
import type { RunnerOpenRequest } from "../../../packages/agent-runtime/src/sandbox-runner-protocol.ts";
import { isAllowedSessionEnvName } from "./runner-env.ts";
import { HttpError } from "./runner-http.ts";

const MAX_ENV_ENTRIES = 256;
const MAX_ENV_VALUE_CHARS = 64 * 1024;
const MAX_PIDS = 1_000_000;
const MAX_WALL_TIME_MS = 7 * 24 * 60 * 60 * 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isWholeNumberIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

export function parseOpenRequest(body: unknown): RunnerOpenRequest {
  if (!isRecord(body)) throw new HttpError(400, "open request must be a JSON object");
  const { taskId, env, limits } = body;
  if (typeof taskId !== "string" || taskId === "" || taskId.length > 200) {
    throw new HttpError(400, "taskId must be a non-empty string of at most 200 characters");
  }
  if (!isRecord(env)) throw new HttpError(400, "env must be an object of strings");
  const entries = Object.entries(env);
  if (entries.length > MAX_ENV_ENTRIES) throw new HttpError(400, "env has too many entries");
  const cleanEnv: Record<string, string> = {};
  for (const [name, value] of entries) {
    // The name is safe to echo; the value never is.
    if (!isAllowedSessionEnvName(name))
      throw new HttpError(400, `env name ${name.slice(0, 40)} is not allowed`);
    if (typeof value !== "string" || value.length > MAX_ENV_VALUE_CHARS || value.includes("\0")) {
      throw new HttpError(400, `env ${name} must be a string without NUL of at most 64 KiB`);
    }
    cleanEnv[name] = value;
  }
  if (!isRecord(limits)) throw new HttpError(400, "limits must be an object");
  if (!isWholeNumberIn(limits.pids, 1, MAX_PIDS))
    throw new HttpError(400, "limits.pids must be a positive integer");
  if (!isWholeNumberIn(limits.wallTimeMs, 1, MAX_WALL_TIME_MS)) {
    throw new HttpError(400, "limits.wallTimeMs must be a positive integer of at most 7 days");
  }
  return { taskId, env: cleanEnv, limits: { pids: limits.pids, wallTimeMs: limits.wallTimeMs } };
}
