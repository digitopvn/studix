/* Small HTTP helpers of the runner: JSON responses, a bounded JSON body reader and the bearer-token check. */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { RUNNER_AUTH_SCHEME } from "../../../packages/agent-runtime/src/sandbox-runner-protocol.ts";

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Reads a JSON request body of at most maxBytes. */
export async function readJson(req: IncomingMessage, maxBytes = 1 << 20): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new HttpError(413, "request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Constant-time check of `Authorization: Bearer <token>` (hashing first equalizes the lengths compared). */
export function createAuthCheck(token: string): (req: IncomingMessage) => boolean {
  const expected = digest(token);
  const prefix = `${RUNNER_AUTH_SCHEME} `;
  return (req) => {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith(prefix)) return false;
    return timingSafeEqual(digest(header.slice(prefix.length)), expected);
  };
}
