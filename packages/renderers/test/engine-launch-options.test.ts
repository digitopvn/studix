import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

interface BrowserManager {
  ownedLaunchOptions: () => Record<string, unknown>;
  buildChromeArgs: (options: { width: number; height: number }) => string[];
}

/** The engine the producer actually loads; it is not a direct dependency of this package. */
async function loadBrowserManager(): Promise<BrowserManager> {
  const producer = import.meta.resolve("@hyperframes/producer");
  const enginePackage = createRequire(producer).resolve("@hyperframes/engine/package.json");
  return import(pathToFileURL(join(dirname(enginePackage), "dist", "services", "browserManager.js")).href);
}

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
});

interface EngineDownloads {
  _setDownloadFetchForTests: (replacement: typeof fetch | undefined) => void;
  downloadToTemp: (url: string, destDir: string) => Promise<string>;
  fetchPublicHttpsText: (url: string, options: { maxBytes: number }) => Promise<string>;
}

interface ProducerLocalizers {
  localizeRemoteImageSources: (html: string, downloadDir: string) => Promise<{ html: string }>;
  localizeRemoteMediaSources: (html: string, downloadDir: string) => Promise<{ html: string }>;
  localizeRemoteFontFaces: (html: string, downloadDir: string) => Promise<{ html: string }>;
}

/** The engine instance the producer imports, so a test transport also sees the producer's downloads. */
async function loadEngine(): Promise<EngineDownloads> {
  const producer = import.meta.resolve("@hyperframes/producer");
  const enginePackage = createRequire(producer).resolve("@hyperframes/engine/package.json");
  return import(pathToFileURL(join(dirname(enginePackage), "dist", "index.js")).href);
}

/**
 * The producer's compiler downloads every `https:` URL that its regexes find in the compiled HTML, and user
 * text can contain one (`background:url(https://…)` in a caption). Studix stages every asset in the project,
 * so the patch makes the engine's downloader refuse every URL: nothing reaches the transport below.
 */
describe("@hyperframes/engine downloads", () => {
  const requests: string[] = [];
  const recordingFetch = (async (input: string | URL | Request) => {
    requests.push(String(input instanceof Request ? input.url : input));
    return new Response("x", { status: 200, headers: { "content-type": "image/png" } });
  }) as typeof fetch;

  it("refuse every URL before any request", async () => {
    const engine = await loadEngine();
    engine._setDownloadFetchForTests(recordingFetch);
    try {
      const dir = mkdtempSync(join(tmpdir(), "studix-downloads-"));
      await expect(engine.downloadToTemp("https://example.com/bg.png", dir)).rejects.toThrow(/disabled/);
      await expect(
        engine.fetchPublicHttpsText("https://example.com/fonts.css", { maxBytes: 1024 }),
      ).rejects.toThrow(/disabled/);

      const producer = (await import("@hyperframes/producer")) as unknown as ProducerLocalizers;
      const pages = [
        '<img src="https://example.com/a.png">',
        '<video src="https://example.com/a.mp4"></video>',
        '<link rel="stylesheet" href="https://example.com/fonts.css"><style>@font-face { src: url(https://example.com/f.woff2); }</style>',
      ];
      expect((await producer.localizeRemoteImageSources(pages[0]!, dir)).html).toBe(pages[0]);
      expect((await producer.localizeRemoteMediaSources(pages[1]!, dir)).html).toBe(pages[1]);
      expect((await producer.localizeRemoteFontFaces(pages[2]!, dir)).html).toBe(pages[2]);
      rmSync(dir, { recursive: true, force: true });
    } finally {
      engine._setDownloadFetchForTests(undefined);
    }
    expect(requests).toEqual([]);
  });
});
