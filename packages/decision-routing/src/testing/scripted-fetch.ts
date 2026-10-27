import type { FetchLike } from "../http-json-client.ts";

export interface RecordedFetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type FetchHandler = (
  call: RecordedFetchCall,
  signal: AbortSignal | undefined,
) => Promise<Response> | Response;

/** fetch replacement that records each request and replies via `handler` (replayed provider responses). */
export function createScriptedFetch(handler: FetchHandler): { fetch: FetchLike; calls: RecordedFetchCall[] } {
  const calls: RecordedFetchCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw signal.reason;
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const raw = typeof init.body === "string" ? init.body : undefined;
    const call: RecordedFetchCall = {
      url,
      method: init.method ?? "GET",
      headers,
      body: raw === undefined ? undefined : JSON.parse(raw),
    };
    calls.push(call);
    return handler(call, signal);
  };
  return { fetch, calls };
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Never answers on its own; rejects like fetch does when the request signal aborts. */
export function hangUntilAborted(signal: AbortSignal | undefined, ms = 10_000): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(jsonResponse(504, { error: { message: "too slow" } })), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
