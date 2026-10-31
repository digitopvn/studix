import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockRequest {
  url: string;
  tools: string[];
  apiKeyHeader: boolean;
}

export interface MockAnthropicServer {
  baseUrl: string;
  requests: MockRequest[];
  close(): Promise<void>;
}

/**
 * Minimal Messages API stand-in for running the real Claude Agent SDK offline. "answer" streams one
 * assistant message that calls the structured-output tool when it is offered; "hang" never answers,
 * like a stuck provider call.
 */
export async function startMockAnthropicServer(
  mode: "answer" | "hang",
  output: Record<string, unknown> = { answer: "ok" },
): Promise<MockAnthropicServer> {
  const requests: MockRequest[] = [];
  let count = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = (body ? JSON.parse(body) : {}) as {
        tools?: Array<{ name: string }>;
        model?: string;
        stream?: boolean;
      };
      const url = req.url ?? "";
      const tools = (parsed.tools ?? []).map((tool) => tool.name);
      requests.push({ url, tools, apiKeyHeader: Boolean(req.headers["x-api-key"]) });
      if (!url.startsWith("/v1/messages") || url.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      if (mode === "hang") return;
      count++;
      const structuredTool = tools.find((name) => /structured/i.test(name));
      const usage = { input_tokens: 1000, output_tokens: 50 };
      const message = {
        id: `msg_mock_${count}`,
        type: "message",
        role: "assistant",
        model: parsed.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usage, output_tokens: 1 },
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", { type: "message_start", message });
      if (structuredTool) {
        send("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: `toolu_mock_${count}`, name: structuredTool, input: {} },
        });
        send("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(output) },
        });
      } else {
        send("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
        send("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: JSON.stringify(output) },
        });
      }
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: structuredTool ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: usage.output_tokens },
      });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
