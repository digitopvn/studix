import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStubHostResolver } from "../src/testing/index.ts";
import { createConnectorUrlPolicy } from "../src/url-policy/connector-url-policy.ts";
import { createPublicWebFetcher } from "../src/url-policy/public-web-fetcher.ts";

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/page")
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<title>Lá</title>");
    else if (req.url === "/hop") res.writeHead(302, { location: "/page" }).end();
    else if (req.url === "/inside") res.writeHead(302, { location: "https://intranet.example/admin" }).end();
    else if (req.url === "/big") res.writeHead(200).end("x".repeat(5000));
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** The test server is the only host allowed over http on a private address, as a local connector would be. */
const fetcher = () =>
  createPublicWebFetcher({
    policy: createConnectorUrlPolicy({
      insecureHosts: [new URL(origin).host],
      resolver: createStubHostResolver({ "intranet.example": [[{ address: "10.0.0.7", family: 4 }]] }),
    }),
  });

describe("public web fetcher", () => {
  it("reads a page and follows a redirect, re-checking every hop", async () => {
    const res = await fetcher().get(`${origin}/hop`, { maxBytes: 1000 });
    expect(res).toEqual({
      url: `${origin}/page`,
      contentType: "text/html",
      body: new TextEncoder().encode("<title>Lá</title>"),
    });
  });

  it("refuses private hosts, also when a public page redirects to one", async () => {
    await expect(fetcher().get("https://localhost/", { maxBytes: 1000 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(fetcher().get(`${origin}/inside`, { maxBytes: 1000 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("stops reading past the byte cap and names a failed status", async () => {
    await expect(fetcher().get(`${origin}/big`, { maxBytes: 100 })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("more than 100 bytes"),
    });
    await expect(fetcher().get(`${origin}/missing`, { maxBytes: 100 })).rejects.toMatchObject({
      message: expect.stringContaining("HTTP 404"),
    });
  });
});
