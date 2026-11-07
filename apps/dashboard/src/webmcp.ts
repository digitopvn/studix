import { api } from "./api-client.ts";

/**
 * WebMCP: the signed-in dashboard offers the Studix MCP tools to an in-browser agent. The server sends the same
 * names, descriptions and input schemas as `/mcp` and runs the same tool code, so the two never drift.
 */
interface WebTool {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
}

interface ModelContext {
  registerTool(tool: {
    name: string;
    title?: string;
    description: string;
    inputSchema: object;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
    execute(args: Record<string, unknown>): Promise<unknown>;
  }): { unregister(): void } | undefined;
}

function modelContext(): ModelContext | undefined {
  const host =
    (document as { modelContext?: ModelContext }).modelContext ??
    (navigator as { modelContext?: ModelContext }).modelContext;
  return typeof host?.registerTool === "function" ? host : undefined;
}

/** Registers the tools when the browser supports WebMCP; returns the cleanup for sign-out or workspace switch. */
export async function registerWebMcpTools(): Promise<() => void> {
  const context = modelContext();
  if (!context) return () => undefined;
  const { tools } = await api.webmcpTools<{ tools: WebTool[] }>();
  const handles = tools.map((tool) =>
    context.registerTool({
      ...tool,
      async execute(args) {
        // The server answers with the same CallToolResult as `/mcp`: envelope text, image blocks, isError.
        try {
          return await api.callWebmcpTool(tool.name, args);
        } catch (e) {
          return {
            isError: true,
            content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
          };
        }
      },
    }),
  );
  return () => {
    for (const h of handles) h?.unregister();
  };
}
