import type { ClaudeQuery, ClaudeQueryFn } from "./claude-agent-runtime.ts";

/**
 * The real SDK transport. Imported lazily so packages that only use the fake never load the SDK
 * or its bundled Claude runtime. The SDK and runtime versions are pinned in package.json and the
 * worker image; nothing here installs or updates anything at request time.
 */
export function createClaudeSdkQuery(): ClaudeQueryFn {
  return async ({ prompt, options }) => {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const query = sdk.query as unknown as (params: { prompt: string; options: unknown }) => ClaudeQuery;
    return query({ prompt, options });
  };
}
