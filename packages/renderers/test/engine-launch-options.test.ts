import { createRequire } from "node:module";
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
