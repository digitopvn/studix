import { StudixError } from "@studix/shared";
import type { RawDownstreamTool } from "../client/mcp-client-adapter.ts";
import type { GatewayLimits } from "../gateway-config.ts";
import type {
  ConnectorTool,
  ConnectorToolAnnotations,
  ConnectorToolFlag,
} from "../registry/connector-types.ts";
import {
  looksLikeInstructions,
  sanitizeDescription,
  stripControlCharacters,
  truncateText,
} from "./untrusted-text-hygiene.ts";

/** Connector names form the `<connector>.` prefix of qualified names, so they cannot contain dots. */
export const CONNECTOR_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,39}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export function byteLength(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : (JSON.stringify(value) ?? ""), "utf8");
}

export function qualifyToolName(connectorName: string, toolName: string): string {
  return `${connectorName}.${toolName}`;
}

/** Split `<connector>.<tool>` at the first dot (tool names may contain dots, connector names never do). */
export function parseQualifiedToolName(qualified: string): { connector: string; tool: string } {
  const dot = qualified.indexOf(".");
  const connector = dot > 0 ? qualified.slice(0, dot) : "";
  const tool = dot > 0 ? qualified.slice(dot + 1) : "";
  if (!CONNECTOR_NAME_PATTERN.test(connector) || !TOOL_NAME_PATTERN.test(tool)) {
    throw new StudixError("VALIDATION", "Tool must be a qualified name like `connector.tool`", {
      suggestedAction: "Use a name returned by studix_tool_search.",
    });
  }
  return { connector, tool };
}

function pickAnnotations(raw: Record<string, unknown> | undefined): ConnectorToolAnnotations {
  const out: ConnectorToolAnnotations = {};
  for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
    if (typeof raw?.[key] === "boolean") out[key] = raw[key] as boolean;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep the schema when it fits the cap; otherwise store a stub that still tells the agent what happened. */
export function boundInputSchema(
  raw: unknown,
  maxBytes: number,
): { schema: Record<string, unknown>; bytes: number; truncated: boolean } {
  const schema = isPlainObject(raw) ? raw : { type: "object" };
  const bytes = byteLength(schema);
  if (bytes <= maxBytes) return { schema, bytes, truncated: false };
  return {
    schema: {
      type: "object",
      additionalProperties: true,
      description: `Input schema omitted: ${bytes} bytes exceeds the ${maxBytes}-byte limit.`,
    },
    bytes,
    truncated: true,
  };
}

/**
 * Convert untrusted listed tools into bounded catalog entries. Invalid names and duplicates are dropped;
 * at most `maxToolsPerConnector` tools are kept.
 */
export function normalizeTools(
  raw: RawDownstreamTool[],
  limits: Pick<GatewayLimits, "maxDescriptionChars" | "maxSchemaBytes" | "maxToolsPerConnector">,
): { tools: ConnectorTool[]; dropped: number } {
  const tools: ConnectorTool[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const item of raw) {
    const name = typeof item?.name === "string" ? item.name : "";
    if (!TOOL_NAME_PATTERN.test(name) || seen.has(name) || tools.length >= limits.maxToolsPerConnector) {
      dropped++;
      continue;
    }
    seen.add(name);
    const flags: ConnectorToolFlag[] = [];
    const description = sanitizeDescription(item.description, limits.maxDescriptionChars);
    const schema = boundInputSchema(item.inputSchema, limits.maxSchemaBytes);
    const title =
      typeof item.title === "string"
        ? truncateText(stripControlCharacters(item.title).trim(), 100).text
        : undefined;
    const titleSuspicious = title !== undefined && looksLikeInstructions(title);
    if (description.suspicious || titleSuspicious || looksLikeInstructions(JSON.stringify(schema.schema))) {
      flags.push("suspicious-instructions");
    }
    if (schema.truncated) flags.push("schema-truncated");
    if (description.truncated) flags.push("description-truncated");
    tools.push({
      name,
      ...(title && !titleSuspicious ? { title } : {}),
      description: description.text,
      inputSchema: schema.schema,
      annotations: pickAnnotations(item.annotations),
      flags,
      schemaBytes: schema.bytes,
    });
  }
  return { tools, dropped };
}
