import { describe, expect, it } from "vitest";
import { GATEWAY_DEPTH_HEADER, parseGatewayDepth } from "../src/client/gateway-depth.ts";
import { createStubHostResolver } from "../src/testing/index.ts";
import { createConnectorUrlPolicy } from "../src/url-policy/connector-url-policy.ts";
import { classifyAddress, embeddedIPv4 } from "../src/url-policy/ip-address-ranges.ts";
import { createPinnedLookup } from "../src/url-policy/pinned-guarded-fetch.ts";

const PUBLIC_V4 = "93.184.216.34";

describe("address classification", () => {
  it.each([
    "10.0.0.5",
    "127.0.0.1",
    "172.16.3.4",
    "192.168.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fd00::1",
    "fc00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a00:1",
  ])("refuses non-public %s", (address) => {
    expect(classifyAddress(address).allowed).toBe(false);
  });

  it.each(["169.254.169.254", "fd00:ec2::254", "::ffff:169.254.169.254", "100.100.100.200"])(
    "refuses metadata address %s even for allowlisted local hosts",
    (address) => {
      expect(classifyAddress(address, { allowPrivate: true }).allowed).toBe(false);
    },
  );

  it("allows public addresses and private ones only when explicitly allowed", () => {
    expect(classifyAddress(PUBLIC_V4).allowed).toBe(true);
    expect(classifyAddress("2606:4700::1111").allowed).toBe(true);
    expect(classifyAddress("127.0.0.1", { allowPrivate: true }).allowed).toBe(true);
    expect(embeddedIPv4("::ffff:192.168.0.1")).toBe("192.168.0.1");
    expect(embeddedIPv4("2606:4700::1111")).toBeUndefined();
  });
});

describe("connector URL policy", () => {
  const policy = createConnectorUrlPolicy({
    insecureHosts: ["127.0.0.1", "mock.local.test"],
    selfOrigins: ["https://app.studix.test", "http://127.0.0.1:8787"],
    resolver: createStubHostResolver({}),
  });

  it("requires https except for allowlisted local hosts", () => {
    expect(() => policy.validate("http://tools.example.com/mcp")).toThrow(/https/);
    expect(policy.validate("https://tools.example.com/mcp").host).toBe("tools.example.com");
    expect(policy.validate("http://127.0.0.1:9999/mcp").port).toBe("9999");
  });

  it("refuses embedded credentials, literal private IPs and local names", () => {
    expect(() => policy.validate("https://user:pw@tools.example.com/mcp")).toThrow(/credentials/);
    expect(() => policy.validate("https://10.1.2.3/mcp")).toThrow(/refused/);
    expect(() => policy.validate("https://169.254.169.254/latest/meta-data")).toThrow(/metadata/);
    expect(() => policy.validate("https://[::ffff:127.0.0.1]/mcp")).toThrow(/refused/);
    expect(() => policy.validate("https://localhost/mcp")).toThrow(/local/);
    expect(() => policy.validate("https://metadata.google.internal/mcp")).toThrow(/local/);
    expect(() => policy.validate("ftp://tools.example.com")).toThrow();
    expect(() => policy.validate("not a url")).toThrow(/valid/);
  });

  it("refuses connectors that point back at Studix (recursion guard)", () => {
    expect(() => policy.validate("https://app.studix.test/mcp")).toThrow(/Studix itself/);
    expect(() => policy.validate("https://app.studix.test:8443/other")).toThrow(/Studix itself/);
    expect(() => policy.validate("http://127.0.0.1:8787/mcp")).toThrow(/Studix itself/);
  });

  it("refuses hosts whose DNS answers include a private or metadata address", async () => {
    const resolver = createStubHostResolver({
      "internal.example.com": [[{ address: "10.0.0.7", family: 4 }]],
      "mixed.example.com": [
        [
          { address: PUBLIC_V4, family: 4 },
          { address: "192.168.0.10", family: 4 },
        ],
      ],
      "meta.example.com": [[{ address: "169.254.169.254", family: 4 }]],
      "good.example.com": [[{ address: PUBLIC_V4, family: 4 }]],
    });
    const p = createConnectorUrlPolicy({ resolver });
    await expect(p.resolve("https://internal.example.com/mcp")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(p.resolve("https://mixed.example.com/mcp")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(p.resolve("https://meta.example.com/mcp")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(p.resolve("https://good.example.com/mcp")).resolves.toMatchObject({ address: PUBLIC_V4 });
    await expect(p.resolve("https://missing.example.com/mcp")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("keeps metadata addresses blocked for allowlisted hosts", async () => {
    const resolver = createStubHostResolver({
      "mock.local.test": [[{ address: "169.254.169.254", family: 4 }]],
    });
    const p = createConnectorUrlPolicy({ insecureHosts: ["mock.local.test"], resolver });
    await expect(p.resolve("http://mock.local.test/mcp")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("pins the validated address so a later DNS answer cannot rebind the connection", async () => {
    const resolver = createStubHostResolver({
      "rebind.example.com": [[{ address: PUBLIC_V4, family: 4 }], [{ address: "127.0.0.1", family: 4 }]],
    });
    const p = createConnectorUrlPolicy({ resolver });
    const pinned = await p.resolve("https://rebind.example.com/mcp");
    const lookup = createPinnedLookup(pinned);
    const answers: unknown[] = [];
    (lookup as unknown as (h: string, o: object, cb: (...a: unknown[]) => void) => void)(
      "rebind.example.com",
      { all: true },
      (_err, addresses) => answers.push(addresses),
    );
    expect(answers).toEqual([[{ address: PUBLIC_V4, family: 4 }]]);
    // The socket-level lookup never consults DNS again, so the attacker's second answer is never used.
    expect(resolver.calls).toEqual(["rebind.example.com"]);
  });
});

describe("gateway depth header", () => {
  it("parses inbound hop counts and fails closed on garbage", () => {
    expect(GATEWAY_DEPTH_HEADER).toBe("x-studix-gateway-depth");
    expect(parseGatewayDepth(undefined)).toBe(0);
    expect(parseGatewayDepth("1")).toBe(1);
    expect(parseGatewayDepth(["2"])).toBe(2);
    expect(parseGatewayDepth("abc")).toBe(99);
  });
});
