import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The worker owns SIGTERM: Chrome must survive it so the render keeps going through the drain grace period.
 * The engine only lets the host take over SIGINT, so `patches/@hyperframes__engine@*.patch` turns Puppeteer's
 * `handleSIGTERM` off. This guards against a HyperFrames bump that drops the patch.
 */
describe("@hyperframes/engine launch options", () => {
  it("leave SIGTERM to the worker", async () => {
    // Resolve the engine the producer actually loads; it is not a direct dependency of this package.
    const producer = import.meta.resolve("@hyperframes/producer");
    const enginePackage = createRequire(producer).resolve("@hyperframes/engine/package.json");
    const browserManager: { ownedLaunchOptions: () => Record<string, unknown> } = await import(
      pathToFileURL(join(dirname(enginePackage), "dist", "services", "browserManager.js")).href
    );
    expect(browserManager.ownedLaunchOptions()).toMatchObject({ handleSIGTERM: false });
  });
});
