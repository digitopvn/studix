import { describe, expect, it } from "vitest";
import { assertPublicHttpsUrl, fetchPublicUrl, killedNote, shellQuote } from "../src/media-exec-runner.ts";

describe("media exec URL inputs", () => {
  it.each([
    ["http://example.com/a.mp4", "only https"],
    ["https://user:pw@example.com/a.mp4", "credentials"],
    ["https://localhost/a.mp4", "internal host"],
    ["https://db.internal/a.mp4", "internal host"],
    ["https://169.254.169.254/latest/meta-data", "private or reserved"],
    ["https://10.0.0.5/a.mp4", "private or reserved"],
    ["https://127.0.0.1/a.mp4", "private or reserved"],
    ["https://[::1]/a.mp4", "private or reserved"],
    ["file:///etc/passwd", "only https"],
  ])("refuses %s", (url, reason) => {
    expect(() => assertPublicHttpsUrl(url)).toThrow(reason);
  });

  it("accepts a public https URL", () => {
    expect(assertPublicHttpsUrl("https://example.com/a.mp4").hostname).toBe("example.com");
  });

  it("refuses a host whose DNS answer is private at connect time", async () => {
    // localtest.me style names resolve to 127.0.0.1; the guarded lookup refuses the socket.
    await expect(
      fetchPublicUrl("https://127.0.0.1.nip.io/a.mp4", 1024, new AbortController().signal),
    ).rejects.toThrow(/private or reserved|could not be fetched/);
  });
});

describe("shellQuote", () => {
  it("keeps every argument one literal word", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's $(rm -rf /)")).toBe(`'it'\\''s $(rm -rf /)'`);
  });
});

describe("killedNote", () => {
  it("names the timeout only when the tool ran for all of it", () => {
    expect(killedNote(60_000, 60)).toBe("[studix] killed after 60s timeout");
    expect(killedNote(5_000, 60)).toBe("[studix] the command was killed");
  });
});
