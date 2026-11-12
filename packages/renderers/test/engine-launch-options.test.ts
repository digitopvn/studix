import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Resolve the engine the producer actually loads; it is not a direct dependency of this package.
const producer = import.meta.resolve("@hyperframes/producer");
const engineDir = dirname(createRequire(producer).resolve("@hyperframes/engine/package.json"));
const engineModule = <T>(file: string): Promise<T> =>
  import(pathToFileURL(join(engineDir, "dist", "services", file)).href);

interface BrowserManager {
  ownedLaunchOptions: () => Record<string, unknown>;
  buildChromeArgs: (
    options: { width: number; height: number; serverUrl?: string },
    config?: Record<string, unknown>,
  ) => string[];
}

/**
 * Studix patches HyperFrames (`patches/@hyperframes__*.patch`). These checks fail when a HyperFrames bump drops
 * a patch, since the real-render tests that exercise them skip on hosts without Chromium, CI included.
 */
describe("@hyperframes/engine launch options", () => {
  it("leave SIGTERM to the worker", async () => {
    // The worker owns SIGTERM: Chrome must survive it so the render keeps going through the drain grace period.
    const browserManager = await engineModule<BrowserManager>("browserManager.js");
    expect(browserManager.ownedLaunchOptions()).toMatchObject({ handleSIGTERM: false });
  });

  it("keep the capture browser off the network except for the file server", async () => {
    const { buildChromeArgs } = await engineModule<BrowserManager>("browserManager.js");
    const args = buildChromeArgs({ width: 640, height: 360, serverUrl: "http://localhost:4123" });
    expect(args).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^--proxy-server=http:\/\/[^ ]+\.invalid:/),
        "--proxy-bypass-list=<-loopback>;localhost:4123",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ]),
    );
  });

  it("pass the file server to the launch flags and confine capture pages to it", () => {
    const source = readFileSync(join(engineDir, "dist", "services", "frameCapture.js"), "utf8");
    expect(source).toContain("requiresWebGpu, serverUrl }, gpuConfig)");
    expect(source).toContain("await confinePageToFileServer(page, serverUrl);");
    expect(source).toContain("await confinePageToFileServer(page, session.serverUrl);");
  });

  it("drop runtime media outside the project", () => {
    const source = readFileSync(fileURLToPath(producer), "utf8");
    expect(source).toMatch(/keepProjectMedia\(\s*await discoverMediaFromBrowser\(session\.page\)/);
  });
});
