import { Client, SdkError, SdkErrorCode, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { isStudixError, redact, StudixError } from "@studix/shared";
import type { OutboundCredential } from "../secrets/secret-resolver.ts";
import type { ConnectorUrlPolicy } from "../url-policy/connector-url-policy.ts";
import { createGuardedFetchSession } from "../url-policy/pinned-guarded-fetch.ts";
import { GATEWAY_DEPTH_HEADER } from "./gateway-depth.ts";

/** Where and how to reach one downstream server for one operation. */
export interface DownstreamTarget {
  url: string;
  /** Outbound credential resolved from the connector's secretRef; inbound credentials never appear here. */
  credential?: OutboundCredential;
  /** Gateway hops already taken by the inbound request (0 for a direct client call). */
  depth: number;
}

export interface DownstreamCallOptions {
  signal: AbortSignal;
  timeoutMs: number;
}

/** Tool definition exactly as listed by the downstream server (untrusted). */
export interface RawDownstreamTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

/** Tool call result exactly as returned by the downstream server (untrusted). */
export interface RawDownstreamResult {
  content: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Phase in which a downstream failure happened. `connect` failures never reached the tool, so retrying
 * cannot duplicate a side effect; `call` failures have an unknown outcome.
 */
export type DownstreamPhase = "connect" | "call";

export class DownstreamError extends StudixError {
  readonly phase: DownstreamPhase;
  constructor(cause: StudixError, phase: DownstreamPhase) {
    super(cause.code, cause.message, {
      retryable: cause.retryable,
      suggestedAction: cause.suggestedAction,
      details: cause.details,
      cause,
    });
    this.name = "DownstreamError";
    this.phase = phase;
  }
}

/** Outbound MCP client seam; the gateway depends on this interface so tests can substitute fakes. */
export interface McpClientAdapter {
  listTools(
    target: DownstreamTarget,
    options: DownstreamCallOptions & { maxTools: number },
  ): Promise<RawDownstreamTool[]>;
  callTool(
    target: DownstreamTarget,
    name: string,
    args: Record<string, unknown>,
    options: DownstreamCallOptions,
  ): Promise<RawDownstreamResult>;
}

export interface SdkMcpClientAdapterOptions {
  policy: ConnectorUrlPolicy;
  maxResponseBytes: number;
  clientVersion?: string;
}

function toDownstreamError(error: unknown, signal: AbortSignal, phase: DownstreamPhase): DownstreamError {
  if (error instanceof DownstreamError) return error;
  if (isStudixError(error)) return new DownstreamError(error, phase);
  const timedOut =
    (signal.aborted && (signal.reason as { name?: string } | undefined)?.name === "TimeoutError") ||
    (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout);
  if (timedOut) {
    return new DownstreamError(
      new StudixError("TIMEOUT", "Connector tool call timed out", { retryable: true }),
      phase,
    );
  }
  if (signal.aborted)
    return new DownstreamError(new StudixError("CANCELLED", "Connector call was cancelled"), phase);
  const message = error instanceof Error ? error.message : String(error);
  // Downstream text is untrusted and may echo credentials: keep it short and redacted.
  const safe = redact(message).slice(0, 300);
  return new DownstreamError(
    phase === "connect"
      ? new StudixError("UNAVAILABLE", `Connector unreachable: ${safe}`, { retryable: true })
      : new StudixError("PROVIDER_ERROR", `Connector call failed: ${safe}`, { retryable: false }),
    phase,
  );
}

/** Production adapter: MCP client SDK over Streamable HTTP through the pinned, policy-checked fetch. */
export function createSdkMcpClientAdapter(options: SdkMcpClientAdapterOptions): McpClientAdapter {
  async function withSession<T>(
    target: DownstreamTarget,
    call: DownstreamCallOptions,
    fn: (client: Client, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const url = options.policy.validate(target.url);
    // Abort the SDK operation as soon as the fetch layer refuses something, instead of waiting for the timeout.
    const violationAbort = new AbortController();
    const signal = AbortSignal.any([call.signal, violationAbort.signal]);
    const session = createGuardedFetchSession({
      policy: options.policy,
      origin: url.origin,
      maxResponseBytes: options.maxResponseBytes,
      onViolation: (error) => violationAbort.abort(error),
    });
    const headers: Record<string, string> = {
      ...(target.credential?.headers ?? {}),
      [GATEWAY_DEPTH_HEADER]: String(target.depth + 1),
    };
    const client = new Client({ name: "studix-mcp-gateway", version: options.clientVersion ?? "0.1.0" });
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: session.fetch,
      requestInit: { headers },
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1,
        maxReconnectionDelay: 1,
        reconnectionDelayGrowFactor: 1,
      },
    });
    let phase: DownstreamPhase = "connect";
    try {
      await client.connect(transport, { signal, timeout: call.timeoutMs });
      phase = "call";
      return await fn(client, signal);
    } catch (error) {
      const violation = session.violation();
      throw toDownstreamError(violation ?? error, call.signal, phase);
    } finally {
      await client.close().catch(() => undefined);
      await session.close();
    }
  }

  return {
    listTools(target, call) {
      return withSession(target, call, async (client, signal) => {
        const tools: RawDownstreamTool[] = [];
        let cursor: string | undefined;
        // Bounded pagination: stop once we have more than the cap (the caller reports the overflow).
        for (let page = 0; page < 20 && tools.length <= call.maxTools; page++) {
          const result = await client.listTools(cursor ? { cursor } : undefined, {
            signal,
            timeout: call.timeoutMs,
          });
          tools.push(...(result.tools as RawDownstreamTool[]));
          cursor = result.nextCursor;
          if (!cursor) break;
        }
        return tools;
      });
    },
    callTool(target, name, args, call) {
      return withSession(target, call, async (client, signal) => {
        const result = await client.callTool({ name, arguments: args }, { signal, timeout: call.timeoutMs });
        return {
          content: Array.isArray(result.content) ? (result.content as unknown[]) : [],
          ...(result.structuredContent
            ? { structuredContent: result.structuredContent as Record<string, unknown> }
            : {}),
          ...(result.isError ? { isError: true } : {}),
        };
      });
    },
  };
}
