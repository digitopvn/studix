import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

interface BrowserManager {
  ownedLaunchOptions: () => Record<string, unknown>;
  buildChromeArgs: (options: { width: number; height: number }) => string[];
}

interface UrlDownloader {
  _setDownloadFetchForTests: (fetch?: typeof globalThis.fetch) => void;
  downloadToTemp: (url: string, destDir: string) => Promise<string>;
  fetchPublicHttpsText: (url: string, options: { maxBytes: number }) => Promise<string>;
}

/** A module of the engine the producer actually loads; it is not a direct dependency of this package. */
async function loadEngineModule<T>(...path: string[]): Promise<T> {
  const producer = import.meta.resolve("@hyperframes/producer");
  const enginePackage = createRequire(producer).resolve("@hyperframes/engine/package.json");
  return import(pathToFileURL(join(dirname(enginePackage), "dist", ...path)).href);
}

const loadBrowserManager = () => loadEngineModule<BrowserManager>("services", "browserManager.js");

/**
 * The worker owns SIGTERM: Chrome must survive it so the render keeps going through the drain grace period.
 * The engine only lets the host take over SIGINT, so `patches/@hyperframes__engine@*.patch` turns Puppeteer's
 * `handleSIGTERM` off. This guards against a HyperFrames bump that drops the patch.
 */
describe("@hyperframes/engine launch options", () => {
  it("leave SIGTERM to the worker", async () => {
    expect((await loadBrowserManager()).ownedLaunchOptions()).toMatchObject({ handleSIGTERM: false });
  });

  // The same patch keeps page scripts off the network; capture-isolation.integration.test.ts proves it end to end.
  it("keep the capture browser off the network", async () => {
    const args = (await loadBrowserManager()).buildChromeArgs({ width: 160, height: 90 });
    expect(args).toEqual(
      expect.arrayContaining([
        "--proxy-server=socks5://127.0.0.1:9",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--webrtc-ip-handling-policy=disable_non_proxied_udp",
      ]),
    );
  });

  // The compiler hands these helpers URLs it matches in compiled HTML, user text included, so they must never
  // fetch. capture-isolation.integration.test.ts proves the whole compile end to end.
  it("refuse to download any URL found in a composition", async () => {
    const engine = await loadEngineModule<UrlDownloader>("index.js");
    const transport = vi.fn(async () => new Response("leak"));
    engine._setDownloadFetchForTests(transport);
    try {
      await expect(engine.downloadToTemp("https://example.com/a.png", tmpdir())).rejects.toThrow(
        /Remote fetches are disabled/,
      );
      await expect(
        engine.fetchPublicHttpsText("https://example.com/a.css", { maxBytes: 1024 }),
      ).rejects.toThrow(/Remote fetches are disabled/);
    } finally {
      engine._setDownloadFetchForTests();
    }
    expect(transport).not.toHaveBeenCalled();
  });
});
