/**
 * Recursion guard header. The gateway stamps every outbound request with the hop count; Studix's own
 * `/mcp` reads it back (via `parseGatewayDepth`) and passes it as `GatewayCallContext.depth`, so an
 * execute arriving through another gateway hop is refused.
 */
export const GATEWAY_DEPTH_HEADER = "x-studix-gateway-depth";

/** Deepest inbound hop count that may still execute downstream tools (direct client calls only). */
export const MAX_GATEWAY_DEPTH = 0;

/** Parse the inbound header value; anything malformed counts as nested so it fails closed. */
export function parseGatewayDepth(value: string | string[] | null | undefined): number {
  if (value === undefined || value === null) return 0;
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === "") return 0;
  const depth = Number(raw);
  return Number.isInteger(depth) && depth >= 0 && depth < 100 ? depth : 99;
}
