import type { LookupFunction } from "node:net";
import { StudixError } from "@studix/shared";
import { Agent, Response as UndiciResponse, fetch as undiciFetch } from "undici";
import type { ConnectorUrlPolicy, PinnedTarget } from "./connector-url-policy.ts";

/** Same shape as the MCP client SDK's `FetchLike`. */
export type GuardedFetchFn = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface GuardedFetchSession {
  fetch: GuardedFetchFn;
  /**
   * The first policy violation seen in this session (refused redirect, oversized response). The MCP SDK
   * may wrap errors thrown by `fetch`; callers report this instead so the real reason is preserved.
   */
  violation(): StudixError | undefined;
  close(): Promise<void>;
}

export interface GuardedFetchOptions {
  policy: ConnectorUrlPolicy;
  /** Origin of the registered connector URL; requests and redirects must stay on it. */
  origin: string;
  maxResponseBytes: number;
  maxRedirects?: number;
  /**
   * Called once with the first violation. The SDK can swallow stream errors and keep waiting for a
   * response, so callers use this to abort the in-flight operation immediately.
   */
  onViolation?: (error: StudixError) => void;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** A `lookup` that ignores DNS and always answers with the validated address (DNS-rebinding defence). */
export function createPinnedLookup(target: Pick<PinnedTarget, "address" | "family">): LookupFunction {
  return ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  }) as unknown as LookupFunction;
}

/** Wrap a body so reading more than `limit` bytes errors the stream. */
function limitBody(body: ReadableStream<Uint8Array>, limit: number, onExceeded: () => StudixError) {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) controller.error(onExceeded());
        else controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * Per-connection fetch for outbound MCP traffic: every host is validated and resolved once, the TCP
 * connection is pinned to that address, redirects are handled manually (same origin only, re-validated),
 * and response bodies are capped.
 */
export function createGuardedFetchSession(options: GuardedFetchOptions): GuardedFetchSession {
  const maxRedirects = options.maxRedirects ?? 3;
  const agents = new Map<string, Agent>();
  let violation: StudixError | undefined;
  const fail = (error: StudixError) => {
    if (!violation) {
      violation = error;
      options.onViolation?.(error);
    }
    return error;
  };

  const agentFor = async (url: URL): Promise<Agent> => {
    const key = url.host.toLowerCase();
    const existing = agents.get(key);
    if (existing) return existing;
    const pinned = await options.policy.resolve(url);
    const agent = new Agent({ connect: { lookup: createPinnedLookup(pinned) } });
    agents.set(key, agent);
    return agent;
  };

  const guardedFetch: GuardedFetchFn = async (input, init = {}) => {
    let url = new URL(String(input));
    for (let hop = 0; ; hop++) {
      if (url.origin !== options.origin) {
        throw fail(new StudixError("FORBIDDEN", "Outbound request to a different origin was refused"));
      }
      const agent = await agentFor(url).catch((error: unknown) => {
        throw error instanceof StudixError ? fail(error) : error;
      });
      // undici's fetch is typed separately from the DOM lib; the init is structurally compatible.
      const response = await undiciFetch(url, {
        ...(init as Record<string, unknown>),
        redirect: "manual",
        dispatcher: agent,
      } as Parameters<typeof undiciFetch>[1]);

      if (REDIRECTS.has(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        const method = (init.method ?? "GET").toUpperCase();
        if (!location || hop >= maxRedirects || (method !== "GET" && response.status < 307)) {
          throw fail(
            new StudixError("PROVIDER_ERROR", "Connector redirect was not followed", { retryable: false }),
          );
        }
        const next = new URL(location, url);
        if (next.origin !== options.origin) {
          throw fail(
            new StudixError("FORBIDDEN", "Connector redirected to a different origin; redirect refused", {
              details: { redirectHost: next.host },
            }),
          );
        }
        url = next;
        continue;
      }

      const declared = Number(response.headers.get("content-length") ?? "0");
      const tooLarge = () =>
        fail(
          new StudixError("PROVIDER_ERROR", `Connector response exceeded ${options.maxResponseBytes} bytes`, {
            retryable: false,
          }),
        );
      if (declared > options.maxResponseBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw tooLarge();
      }
      // undici types its body as node:stream/web ReadableStream; it is the same runtime class as the DOM one.
      const source = response.body as unknown as ReadableStream<Uint8Array> | null;
      const body = source ? limitBody(source, options.maxResponseBytes, tooLarge) : null;
      const wrapped = new UndiciResponse(body as unknown as ConstructorParameters<typeof UndiciResponse>[0], {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      // The SDK only uses the standard Response surface, which undici implements.
      return wrapped as unknown as Response;
    }
  };

  return {
    fetch: guardedFetch,
    violation: () => violation,
    async close() {
      const all = [...agents.values()];
      agents.clear();
      // The session is over: drop any lingering streams instead of waiting for them.
      await Promise.all(all.map((agent) => agent.destroy().catch(() => undefined)));
    },
  };
}
