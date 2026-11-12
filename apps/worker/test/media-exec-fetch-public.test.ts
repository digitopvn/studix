import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Each request answers with these response chunks, headers and status. */
let reply: { status: number; headers: Record<string, string>; chunks: string[] };

vi.mock("node:https", () => ({
  request: (_url: URL, _options: unknown, onResponse: (res: unknown) => void) => {
    const req = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: () => {
        const res = Object.assign(new PassThrough(), {
          statusCode: reply.status,
          headers: reply.headers,
        });
        onResponse(res);
        for (const chunk of reply.chunks) res.write(chunk);
        res.end();
      },
    });
    return req;
  },
}));

const { fetchPublic } = await import("../src/media-exec-runner.ts");
const signal = new AbortController().signal;
const text = (body: Uint8Array) => new TextDecoder().decode(body);

describe("fetchPublic body cap", () => {
  beforeEach(() => {
    reply = {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "content-length": "20" },
      chunks: ["<head>abc", "def</head>body"],
    };
  });

  it("refuses a body over the cap by default", async () => {
    await expect(fetchPublic("https://example.com/", { maxBytes: 10 }, signal)).rejects.toThrow(
      "larger than the input limit",
    );
    reply.headers = { "content-type": "text/html" };
    await expect(fetchPublic("https://example.com/", { maxBytes: 10 }, signal)).rejects.toThrow(
      "larger than the input limit",
    );
  });

  it("keeps the first maxBytes of a truncating read, with the type and final URL", async () => {
    const page = await fetchPublic("https://example.com/", { maxBytes: 12, truncate: true }, signal);
    expect(text(page.body)).toBe("<head>abcdef");
    expect(page.contentType).toBe("text/html");
    expect(page.url).toBe("https://example.com/");
  });

  it("returns the whole body when it fits", async () => {
    const page = await fetchPublic("https://example.com/", { maxBytes: 100 }, signal);
    expect(text(page.body)).toBe("<head>abcdef</head>body");
  });
});
