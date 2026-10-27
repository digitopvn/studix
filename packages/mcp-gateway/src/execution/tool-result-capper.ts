import type { TenantContext } from "@studix/core";
import { byteLength } from "../catalog/tool-normalizer.ts";
import {
  looksLikeInstructions,
  stripControlCharacters,
  truncateText,
} from "../catalog/untrusted-text-hygiene.ts";
import type { RawDownstreamResult } from "../client/mcp-client-adapter.ts";
import { UNTRUSTED_NOTICE } from "./gateway-call-context.ts";

/** Optional sink for results too large to return inline (e.g. an S3-backed asset store). */
export interface LargeResultStore {
  put(
    ctx: TenantContext,
    input: { qualifiedTool: string; jobId?: string; contentType: "application/json"; body: Uint8Array },
  ): Promise<{ assetRef: string }>;
}

export type ResultFlag = "suspicious-instructions" | "truncated" | "binary-omitted" | "stored-as-asset";

/** Downstream output as handed back to the agent: labelled, sanitized and size-bounded. */
export interface UntrustedToolOutput {
  untrusted: true;
  source: string;
  notice: string;
  isError: boolean;
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  flags: ResultFlag[];
  truncated: boolean;
  originalBytes: number;
  resultBytes: number;
  assetRef?: string;
}

const PREVIEW_CHARS = 2_000;

function approxBase64Bytes(data: unknown): number {
  return typeof data === "string" ? Math.floor((data.length * 3) / 4) : 0;
}

/** Keep text and links; replace inline binary with a placeholder (media travels as asset refs, never inline). */
function sanitizeBlock(block: unknown, flags: Set<ResultFlag>): Record<string, unknown> {
  const b = (typeof block === "object" && block !== null ? block : {}) as Record<string, unknown>;
  switch (b.type) {
    case "text":
      return { type: "text", text: stripControlCharacters(String(b.text ?? "")) };
    case "image":
    case "audio":
      flags.add("binary-omitted");
      return {
        type: b.type,
        mimeType: String(b.mimeType ?? ""),
        omitted: true,
        bytes: approxBase64Bytes(b.data),
      };
    case "resource_link":
      return { type: "resource_link", uri: String(b.uri ?? ""), name: String(b.name ?? "") };
    case "resource": {
      const r = (b.resource ?? {}) as Record<string, unknown>;
      if (typeof r.text === "string") {
        return { type: "resource", uri: String(r.uri ?? ""), text: stripControlCharacters(r.text) };
      }
      flags.add("binary-omitted");
      return { type: "resource", uri: String(r.uri ?? ""), omitted: true, bytes: approxBase64Bytes(r.blob) };
    }
    default:
      flags.add("binary-omitted");
      return { type: "unsupported", omitted: true };
  }
}

/** Cut a string to at most `maxBytes` UTF-8 bytes. */
function cutBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  return buf.byteLength <= maxBytes ? text : buf.subarray(0, maxBytes).toString("utf8");
}

export interface CapOptions {
  ctx: TenantContext;
  connectorName: string;
  qualifiedTool: string;
  jobId?: string;
  maxResultBytes: number;
  store?: LargeResultStore;
}

/**
 * Wrap a downstream result: label it as untrusted data, flag instruction-like text, drop inline binary,
 * and enforce the inline byte cap (store the full result as an asset when a store is configured,
 * otherwise return a compact truncated text preview).
 */
export async function capToolResult(
  raw: RawDownstreamResult,
  options: CapOptions,
): Promise<UntrustedToolOutput> {
  const flags = new Set<ResultFlag>();
  let content = raw.content.map((block) => sanitizeBlock(block, flags));
  let structuredContent = raw.structuredContent;
  const originalBytes = byteLength({ content: raw.content, structuredContent: raw.structuredContent });
  const texts = content.map((c) => (typeof c.text === "string" ? c.text : "")).join("\n");
  if (
    looksLikeInstructions(texts) ||
    (structuredContent && looksLikeInstructions(JSON.stringify(structuredContent)))
  ) {
    flags.add("suspicious-instructions");
  }

  let assetRef: string | undefined;
  let truncated = false;
  if (byteLength({ content, structuredContent }) > options.maxResultBytes) {
    truncated = true;
    flags.add("truncated");
    structuredContent = undefined;
    if (options.store) {
      const body = new TextEncoder().encode(
        JSON.stringify({ content: raw.content, structuredContent: raw.structuredContent }),
      );
      assetRef = (
        await options.store.put(options.ctx, {
          qualifiedTool: options.qualifiedTool,
          ...(options.jobId ? { jobId: options.jobId } : {}),
          contentType: "application/json",
          body,
        })
      ).assetRef;
      flags.add("stored-as-asset");
      content = [{ type: "text", text: truncateText(texts, PREVIEW_CHARS).text }];
    } else {
      // Leave headroom for the envelope and labels around the preview.
      const budget = Math.max(256, options.maxResultBytes - 1_024);
      content = [{ type: "text", text: `${cutBytes(texts, budget)}…` }];
    }
  }

  const body = { content, ...(structuredContent ? { structuredContent } : {}) };
  return {
    untrusted: true,
    source: `connector:${options.connectorName}`,
    notice: UNTRUSTED_NOTICE,
    isError: raw.isError === true,
    ...body,
    flags: [...flags],
    truncated,
    originalBytes,
    resultBytes: byteLength(body),
    ...(assetRef ? { assetRef } : {}),
  };
}
