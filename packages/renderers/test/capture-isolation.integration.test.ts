import { execFileSync, spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { createLogger } from "@studix/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildComposition, writeComposition } from "../src/hyperframes/compile-composition.ts";
import { renderWithProducer } from "../src/hyperframes/producer-render.ts";
import { loadIrFixture, renderToolchain, tempDir } from "./render-test-helpers.ts";

const toolchain = renderToolchain();
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((c) => c()));
});

/** A non-loopback address of this host: what a capture page would use to reach the worker's network. */
function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) if (nic.family === "IPv4" && !nic.internal) return nic.address;
  }
  return undefined;
}

/** Loudest sample of the capture's audio in dBFS, or -Infinity when it has no audio stream. */
function maxVolumeDb(file: string): number {
  const streams = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file],
    {
      encoding: "utf8",
    },
  );
  if (!streams.trim()) return Number.NEGATIVE_INFINITY;
  const { stderr } = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"],
    {
      encoding: "utf8",
    },
  );
  const match = /max_volume: (-?[\d.]+|-inf) dB/.exec(stderr);
  return !match?.[1] || match[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(match[1]);
}

/**
 * Every capture runs in a browser that reaches only the producer's file server, and the producer reads only
 * media inside the project, whatever a page script tries (patches/@hyperframes__engine and __producer).
 */
describe.skipIf(!toolchain.ok)(
  `HyperFrames capture isolation${toolchain.ok ? "" : ` (skipped: ${toolchain.reason})`}`,
  () => {
    const hits: string[] = [];
    let udpPackets = 0;
    const server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.end("canary");
    });
    server.on("upgrade", (req, socket) => {
      hits.push(`UPGRADE ${req.url}`);
      socket.destroy();
    });
    const udp = createSocket("udp4");
    udp.on("message", () => {
      udpPackets++;
    });
    let dir = "";
    let secret = "";
    // Without a non-loopback address the LAN probes fall back to loopback, which the browser must block too.
    const host = lanAddress() ?? "127.0.0.1";

    beforeAll(async () => {
      await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
      await new Promise<void>((resolve) => udp.bind(0, "0.0.0.0", resolve));
      const tmp = await tempDir("capture-isolation");
      cleanups.push(tmp.cleanup, async () => {
        server.close();
        udp.close();
      });
      dir = tmp.dir;
      // A loud host file outside every project directory.
      secret = join(dir, "secret.wav");
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=3",
        "-y",
        secret,
      ]);
    });

    async function capture(name: string, script: string): Promise<{ output: string; logs: string }> {
      const ir = loadIrFixture("brand-intro-9x16");
      const projectDir = join(dir, name);
      const build = buildComposition(ir, { width: 540, height: 960, assetFiles: {} });
      await writeComposition(build, projectDir);
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=3",
        "-y",
        join(projectDir, "inside.wav"),
      ]);
      const index = join(projectDir, "index.html");
      const html = await readFile(index, "utf8");
      await writeFile(index, html.replace("</body>", `<script>${script}</script></body>`));
      const output = join(dir, `${name}.mp4`);
      const lines: string[] = [];
      await renderWithProducer({
        projectDir,
        outputPath: output,
        fps: 6,
        quality: "draft",
        crf: 35,
        workers: 1,
        logger: createLogger({}, { level: "warn", write: (line) => lines.push(line) }),
        onProgress: () => {},
      });
      return { output, logs: lines.join("\n") };
    }

    /**
     * Creates a runtime audio element the producer would mix, as page scripts could. With `spoof`, the element
     * reports that src through an overridden `currentSrc`, which is what the producer reads.
     */
    const runtimeAudio = (id: string, src: string, spoof = false) =>
      `{const a=document.createElement("audio");a.id=${JSON.stringify(id)};a.setAttribute("data-start","0");a.setAttribute("data-duration","3");a.setAttribute("data-has-audio","true");${
        spoof
          ? `Object.defineProperty(a,"currentSrc",{get:()=>${JSON.stringify(src)}});a.src="inside.wav";`
          : `a.src=${JSON.stringify(src)};`
      }document.body.appendChild(a);}`;

    it("keeps runtime media that lives inside the project", async () => {
      const { output } = await capture("control", runtimeAudio("inside", "inside.wav"));
      expect(maxVolumeDb(output)).toBeGreaterThan(-20);
    });

    it("blocks requests, popups, WebSockets and WebRTC to the LAN and other loopback ports, and never reads media outside the project", async () => {
      const port = (server.address() as AddressInfo).port;
      const udpPort = (udp.address() as AddressInfo).port;
      const lan = `http://${host}:${port}`;
      const victim = join(dir, "victim");
      await mkdir(victim);
      // Other loopback ports, as the producer's file server is on localhost too.
      const local = `http://localhost:${port}`;
      const script = [
        `fetch("${lan}/fetch").catch(()=>{});`,
        `fetch("${local}/fetch-localhost").catch(()=>{});`,
        `fetch("http://127.0.0.1:${port}/fetch-loopback-ip").catch(()=>{});`,
        `new Image().src="${lan}/image";`,
        `navigator.sendBeacon("${lan}/beacon");`,
        `try{new WebSocket("ws://${host}:${port}/socket")}catch{}`,
        `try{new WebSocket("ws://localhost:${port}/socket-localhost")}catch{}`,
        `try{new Worker(URL.createObjectURL(new Blob(['fetch("${local}/worker").catch(()=>{})'])))}catch{}`,
        `{const f=document.createElement("iframe");f.src="${local}/iframe";document.body.appendChild(f);}`,
        `window.open("${lan}/popup");`,
        `window.open("${local}/popup-localhost","_blank","noopener");`,
        `{const l=document.createElement("a");l.href="${local}/link-localhost";l.target="_blank";document.body.appendChild(l);l.click();}`,
        `{const pc=new RTCPeerConnection({iceServers:[{urls:"stun:${host}:${udpPort}"}]});pc.createDataChannel("x");pc.createOffer().then((o)=>pc.setLocalDescription(o)).catch(()=>{});}`,
        `setTimeout(()=>{location.href="${lan}/navigate"},20);`,
        runtimeAudio("by-url", `${lan}/secret.wav`),
        runtimeAudio("by-file-url", `file://${secret}`),
        runtimeAudio("by-encoded-dots", "..%2fsecret.wav"),
        runtimeAudio("by-spaced-path", ` ${secret}`, true),
        runtimeAudio("by-spaced-dots", " ../secret.wav", true),
        // The engine joins media ids into work-directory paths; this one points back at `victim`.
        runtimeAudio(`${"../".repeat(16)}${victim.slice(1)}/pwned`, "inside.wav"),
      ].join("\n");

      const { output, logs } = await capture("hostile", script);

      // Give late requests (beacon, popup, ICE) time to land before checking that none did.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(hits).toEqual([]);
      expect(udpPackets).toBe(0);
      // The host file was never mixed in.
      expect(maxVolumeDb(output)).toBe(Number.NEGATIVE_INFINITY);
      // The page script ran: the producer saw and dropped each element it created.
      for (const id of ["by-url", "by-file-url", "by-encoded-dots", "by-spaced-path", "by-spaced-dots"]) {
        expect(logs).toContain(`"id":"${id}"`);
      }
      expect(logs).toContain("/pwned");
      expect(await readdir(victim)).toEqual([]);
    });
  },
);
