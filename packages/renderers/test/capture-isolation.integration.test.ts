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
import { buildSequentialTimeline, resolveRenderSpec, type VideoIR } from "@studix/video-ir";
import { afterAll, describe, expect, it, vi } from "vitest";
import { renderWithProducer } from "../src/hyperframes/producer-render.ts";
import { HyperFramesRenderer } from "../src/index.ts";
import { CLEAN_CARD, cardIr, writeCard } from "./html-card-fixture.ts";
import { PNG_1X1, renderToolchain, tempDir } from "./render-test-helpers.ts";

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
  canary: string,
  stunPort: number,
  secretSrcs: string[],
  projectSrcs: string[],
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
    </div>
    <script>
      (function () {
        var canary = ${JSON.stringify(canary)};
        try { fetch(canary + "/fetch", { mode: "no-cors" }).catch(function () {}); } catch (e) {}
        try { navigator.sendBeacon(canary + "/beacon", "x"); } catch (e) {}
        try { new Image().src = canary + "/image"; } catch (e) {}
        try { new WebSocket(canary.replace("http", "ws") + "/ws"); } catch (e) {}
        try { window.open(canary + "/popup"); } catch (e) {}
        try {
          var frame = document.createElement("iframe");
          frame.src = canary + "/iframe";
          document.body.appendChild(frame);
        } catch (e) {}
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

/** A started canary: an HTTP/WebSocket server and a UDP (STUN) socket on a non-loopback address. */
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
        hostileIndexHtml(canary.url, canary.stunPort, secretSrcs(secret, canary.url), projectSrcs),
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

    it("sends no request from page scripts off the machine", async () => {
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
  },
);

/** The engine the producer loads, for its download test seam. */
async function loadEngine(): Promise<{
  _setDownloadFetchForTests: (fetch?: typeof globalThis.fetch) => void;
}> {
  const enginePackage = createRequire(import.meta.resolve("@hyperframes/producer")).resolve(
    "@hyperframes/engine/package.json",
  );
  return import(pathToFileURL(join(dirname(enginePackage), "dist", "index.js")).href);
}

/**
 * Text a user could type into a title, a text shot or a caption, aimed at the compiler's URL rewriters. Text
 * cannot become an element or attribute, so the host-file copy is guarded by the raw-page test below.
 */
const HOSTILE_TEXT =
  "background:url(https://egress-canary.example/bg.png) @font-face{src:url(https://egress-canary.example/f.woff2)}";

/** A text-only composition whose title, text shot and caption all carry `text`. */
function textIr(text: string): VideoIR {
  const scenes: VideoIR["scenes"] = [
    {
      id: "intro",
      role: "intro",
      durationMs: 1000,
      background: { color: "background" },
      shots: [{ id: "hello", type: "text", text, startMs: 0, durationMs: 1000 }],
    },
  ];
  return {
    schemaVersion: 1,
    title: text,
    language: "en",
    format: { aspectRatio: "16:9", width: 256, height: 144, fps: 12, durationMs: 1000 },
    assets: [],
    scenes,
    timeline: buildSequentialTimeline(scenes),
    captions: { language: "en", mode: "burned", cues: [{ startMs: 0, endMs: 1000, text }] },
  };
}

/** Whether `url` targets this machine's loopback, where the producer's own file server listens. */
function isLoopback(url: string): boolean {
  const { hostname } = new URL(url);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

const requestUrl = (input: unknown) => (input instanceof Request ? input.url : String(input));

describe.skipIf(!toolchain.ok)(
  `HyperFrames compile isolation${toolchain.ok ? "" : ` (skipped: ${toolchain.reason})`}`,
  () => {
    /** Render `ir` and return every download and non-loopback fetch the compile and capture made. */
    async function remoteRequests(ir: VideoIR, assetFiles: Record<string, string> = {}): Promise<string[]> {
      const engine = await loadEngine();
      const requests: string[] = [];
      engine._setDownloadFetchForTests(async (input) => {
        requests.push(`download ${requestUrl(input)}`);
        return new Response(PNG_1X1, { headers: { "content-type": "image/png" } });
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const { dir, cleanup } = await tempDir("compile-isolation");
      cleanups.push(cleanup);
      try {
        const output = await new HyperFramesRenderer({ workers: 1 }).render(ir, {
          spec: resolveRenderSpec("preview", { fps: 12 }),
          workDir: dir,
          assetFiles,
        });
        expect(output.probe).toMatchObject({ videoCodec: "h264" });
      } finally {
        engine._setDownloadFetchForTests();
      }
      // mockRestore() also clears the recorded calls, so read them first.
      const calls = [...fetchSpy.mock.calls];
      fetchSpy.mockRestore();
      for (const [input] of calls) {
        const url = requestUrl(input);
        if (!isLoopback(url)) requests.push(`fetch ${url}`);
      }
      return requests;
    }

    it("makes no outbound request for URLs written into composition text", async () => {
      expect(await remoteRequests(textIr(HOSTILE_TEXT))).toEqual([]);
    });

    // A family without @font-face would make the compiler ask Google Fonts, sending the page's characters.
    it.each(["Helvetica", "Lobster"])("makes no outbound request for a card font %s", async (family) => {
      const { dir, cleanup } = await tempDir("compile-card-font");
      cleanups.push(cleanup);
      // An empty font cache: a cached Google Fonts response would hide the request.
      vi.stubEnv("HYPERFRAMES_FONT_CACHE_DIR", join(dir, "font-cache"));
      cleanups.push(() => {
        vi.unstubAllEnvs();
      });
      expect(CLEAN_CARD.css).toContain("font-family: var(--font-heading);");
      const file = await writeCard(dir, {
        ...CLEAN_CARD,
        css: CLEAN_CARD.css.replace("font-family: var(--font-heading);", `font-family: ${family};`),
      });
      expect(await remoteRequests(cardIr(file), { "hero-card": file })).toEqual([]);
    });

    it("never copies a host file outside the project into the render", async () => {
      const { dir, cleanup } = await tempDir("compile-host-file");
      cleanups.push(cleanup);
      await mkdir(join(dir, "secret"), { recursive: true });
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=160x90",
        "-frames:v",
        "1",
        join(dir, "secret", "red.png"),
      ]);
      const projectDir = join(dir, "a", "b", "project");
      await mkdir(join(projectDir, "assets", "vendor"), { recursive: true });
      await copyFile(
        require.resolve("gsap/dist/gsap.min.js"),
        join(projectDir, "assets", "vendor", "gsap.min.js"),
      );
      const secret = "../../../secret/red.png";
      await writeFile(
        join(projectDir, "index.html"),
        `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script src="assets/vendor/gsap.min.js"></script>
    <style>
      html, body, #root { margin: 0; width: 160px; height: 90px; overflow: hidden; background: #000; }
      .css { position: absolute; left: 80px; top: 0; width: 80px; height: 90px; background: url("${secret}") center / cover; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="160" data-height="90">
      <img src="${secret}" style="position:absolute;left:0;top:0;width:40px;height:90px" />
      <div style="position:absolute;left:40px;top:0;width:40px;height:90px;background-image:url(${secret})"></div>
      <div class="css"></div>
    </div>
    <script>
      var tl = gsap.timeline({ paused: true });
      tl.set({}, {}, 1);
      window.__timelines = { main: tl };
    </script>
  </body>
</html>
`,
      );
      const outputPath = join(dir, "out.mp4");
      await renderWithProducer({
        projectDir,
        outputPath,
        fps: 12,
        quality: "draft",
        crf: 30,
        workers: 1,
        logger: createLogger({ component: "compile-isolation-test" }, { level: "error" }),
        onProgress: () => {},
      });
      // The <img>, the inline style and the stylesheet each cover part of the frame; red means a host file
      // reached the render. A broken-image placeholder may tint the frame grey, never red.
      const [r, g, b] = frameColor(outputPath, 0.5);
      expect(r - (g + b) / 2).toBeLessThan(10);
    });
  },
);
