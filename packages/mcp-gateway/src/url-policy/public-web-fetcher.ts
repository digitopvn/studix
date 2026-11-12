import { StudixError } from "@studix/shared";
import { Agent, fetch as undiciFetch } from "undici";
import { type ConnectorUrlPolicy, createConnectorUrlPolicy } from "./connector-url-policy.ts";
import { createPinnedLookup } from "./pinned-guarded-fetch.ts";

/** A public web resource read by a stage (a brand's site, its logo). */
export interface PublicWebResponse {
  /** Final URL, after redirects. */
  url: string;
  contentType: string;
  body: Uint8Array;
}

export interface PublicWebGetOptions {
  maxBytes: number;
  /** `Accept` header, e.g. `text/html` or `image/*`. */
  accept?: string;
  signal?: AbortSignal;
}

/** Reads public https resources for stages. Every host is checked by the SSRF policy before it is reached. */
export interface PublicWebFetcher {
  get(url: string, options: PublicWebGetOptions): Promise<PublicWebResponse>;
}

export interface PublicWebFetcherOptions {
  policy?: ConnectorUrlPolicy;
  /** Studix's own origins; never fetched. */
  selfOrigins?: string[];
  timeoutMs?: number;
  maxRedirects?: number;
  userAgent?: string;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * GETs public https URLs: each hop (redirects too, which may change origin) is validated and resolved by the
 * connector URL policy, the connection is pinned to the checked address (DNS-rebinding defence), and the
 * body is capped by `maxBytes` and the whole read by `timeoutMs`. Fails `FORBIDDEN` for a refused host,
 * `PROVIDER_ERROR` for a bad status or an oversized body, `TIMEOUT` past the time cap.
 */
export function createPublicWebFetcher(options: PublicWebFetcherOptions = {}): PublicWebFetcher {
  const policy = options.policy ?? createConnectorUrlPolicy({ selfOrigins: options.selfOrigins ?? [] });
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxRedirects = options.maxRedirects ?? 4;
  const userAgent = options.userAgent ?? "StudixBot/1.0 (+https://studix.app)";

  return {
    async get(raw, { maxBytes, accept, signal }) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const agents: Agent[] = [];
      try {
        let url = new URL(raw);
        for (let hop = 0; ; hop++) {
          const pinned = await policy.resolve(url);
          const agent = new Agent({ connect: { lookup: createPinnedLookup(pinned) } });
          agents.push(agent);
          const response = await undiciFetch(pinned.url, {
            redirect: "manual",
            dispatcher: agent,
            signal: abort,
            headers: { "user-agent": userAgent, accept: accept ?? "*/*" },
          });
          if (REDIRECTS.has(response.status)) {
            await response.body?.cancel().catch(() => undefined);
            const location = response.headers.get("location");
            if (!location || hop >= maxRedirects) {
              throw new StudixError("PROVIDER_ERROR", `${url.host} redirected too many times`, {
                retryable: false,
              });
            }
            url = new URL(location, url);
            continue;
          }
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new StudixError("PROVIDER_ERROR", `${url.host} answered HTTP ${response.status}`, {
              retryable: response.status >= 500,
              details: { status: response.status },
            });
          }
          const tooLarge = () =>
            new StudixError("PROVIDER_ERROR", `${url.host} sent more than ${maxBytes} bytes`, {
              retryable: false,
            });
          if (Number(response.headers.get("content-length") ?? "0") > maxBytes) {
            await response.body?.cancel().catch(() => undefined);
            throw tooLarge();
          }
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          if (response.body) {
            for await (const chunk of response.body) {
              bytes += chunk.byteLength;
              if (bytes > maxBytes) throw tooLarge();
              chunks.push(chunk);
            }
          }
          const body = new Uint8Array(bytes);
          let at = 0;
          for (const chunk of chunks) {
            body.set(chunk, at);
            at += chunk.byteLength;
          }
          return {
            url: url.toString(),
            contentType:
              (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "",
            body,
          };
        }
      } catch (error) {
        if (timeout.aborted && !signal?.aborted) {
          throw new StudixError("TIMEOUT", `Reading ${raw} took longer than ${timeoutMs} ms`, {
            retryable: true,
          });
        }
        throw error;
      } finally {
        await Promise.all(agents.map((a) => a.destroy().catch(() => undefined)));
      }
    },
  };
}
