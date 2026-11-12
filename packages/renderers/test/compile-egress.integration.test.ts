import dns from "node:dns";
import fs from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { createRequire, syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { join, relative, resolve } from "node:path";
import tls from "node:tls";
import { createLogger } from "@studix/shared";
import { resolveRenderSpec } from "@studix/video-ir";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderWithProducer } from "../src/hyperframes/producer-render.ts";
import { HyperFramesRenderer } from "../src/index.ts";
import { loadIrFixture, PNG_1X1, renderToolchain, tempDir } from "./render-test-helpers.ts";

const require = createRequire(import.meta.url);

const toolchain = renderToolchain();
const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\]|::ffff:127\.\d+\.\d+\.\d+)$/i;

function hostOf(target: unknown): string {
  if (typeof target === "string" || target instanceof URL) {
    try {
      return new URL(String(target)).hostname;
    } catch {
      return String(target);
    }
  }
  if (target && typeof target === "object") {
    const o = target as { hostname?: string; host?: string; url?: string };
    if (o.url) return hostOf(o.url);
    return o.hostname ?? o.host ?? "localhost";
  }
  return "localhost";
}

/**
 * Every outbound DNS lookup, HTTP(S) request, fetch, TCP and TLS connect the render process makes to a host
 * that is not loopback is recorded and refused, so nothing really leaves the machine while the test runs.
 * Every file the process opens, reads or copies is recorded too, as `<call> <path>`.
 */
function trapEgress(): { attempts: string[]; files: string[]; restore: () => void } {
  const attempts: string[] = [];
  const files: string[] = [];
  const restores: (() => void)[] = [];
  const refuse = (kind: string, host: string) => {
    attempts.push(`${kind} ${host}`);
    return new Error(`test blocked ${kind} to ${host}`);
  };
  const wrap = <T extends object>(
    obj: T,
    key: keyof T,
    kind: string,
    hostArg: (args: unknown[]) => unknown,
  ) => {
    const original = obj[key] as (...args: unknown[]) => unknown;
    (obj as Record<keyof T, unknown>)[key] = function (this: unknown, ...args: unknown[]) {
      const host = hostOf(hostArg(args));
      if (!LOOPBACK.test(host)) {
        const err = refuse(kind, host);
        if (kind === "fetch" || kind === "dns.promises") return Promise.reject(err);
        throw err;
      }
      return original.apply(this, args);
    };
    restores.push(() => {
      (obj as Record<keyof T, unknown>)[key] = original;
    });
  };
  wrap(globalThis, "fetch", "fetch", (a) => a[0]);
  wrap(http, "request", "http", (a) => a[0]);
  wrap(http, "get", "http", (a) => a[0]);
  wrap(https, "request", "https", (a) => a[0]);
  wrap(https, "get", "https", (a) => a[0]);
  wrap(dns, "lookup", "dns", (a) => a[0]);
  wrap(dns.promises, "lookup", "dns.promises", (a) => a[0]);
  wrap(net, "connect", "net", (a) => (typeof a[0] === "object" ? a[0] : a[1]));
  wrap(net, "createConnection", "net", (a) => (typeof a[0] === "object" ? a[0] : a[1]));
  wrap(tls, "connect", "tls", (a) => (typeof a[0] === "object" ? a[0] : a[1]));
  for (const [obj, key] of [
    [fs, "copyFileSync"],
    [fs, "copyFile"],
    [fs, "cpSync"],
    [fs, "readFileSync"],
    [fs, "readFile"],
    [fs, "openSync"],
    [fs, "open"],
    [fs, "createReadStream"],
    [fs.promises, "copyFile"],
    [fs.promises, "cp"],
    [fs.promises, "readFile"],
    [fs.promises, "open"],
  ] as const) {
    const original = (obj as Record<string, unknown>)[key] as (...args: unknown[]) => unknown;
    (obj as Record<string, unknown>)[key] = function (this: unknown, ...args: unknown[]) {
      if (typeof args[0] === "string" || args[0] instanceof URL)
        files.push(`${key} ${resolve(String(args[0]))}`);
      return original.apply(this, args);
    };
    restores.push(() => {
      (obj as Record<string, unknown>)[key] = original;
    });
  }
  syncBuiltinESMExports();
  return {
    attempts,
    files,
    restore: () => {
      for (const r of restores.reverse()) r();
      syncBuiltinESMExports();
    },
  };
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

// Skips (with the missing tool in the title) only when the host lacks Chromium or FFmpeg.
describe.skipIf(!toolchain.ok)(
  `HyperFrames compile egress${toolchain.ok ? "" : ` (skipped: ${toolchain.reason})`}`,
  () => {
    let trap: ReturnType<typeof trapEgress>;
    beforeAll(() => {
      trap = trapEgress();
      cleanups.push(() => trap.restore());
    });

    it("fetches no URL and copies no host file named in composition text", async () => {
      const outside = await tempDir("egress-host");
      const work = await tempDir("egress-render");
      cleanups.push(outside.cleanup, work.cleanup);
      const marker = `studix-host-secret-${process.pid}-${Date.now()}`;
      const secret = join(outside.dir, "secret.png");
      await writeFile(secret, marker);
      const upward = `${"../".repeat(12)}${secret.replace(/^\//, "")}`;
      const hostile = [
        "background:url(https://canary.example/bg.png)",
        `background-image:url(${upward})`,
        `background-image:url(${secret})`,
      ];

      // The IR title, a title shot and the captions each carry one of the hostile strings.
      const ir = loadIrFixture("brand-intro-9x16");
      ir.title = hostile[0]!;
      const shot = ir.scenes[0]!.shots[0]!;
      if (shot.type !== "title") throw new Error("fixture changed");
      shot.text = hostile[1]!;
      ir.captions!.cues = ir.captions!.cues.map((cue, i) => ({ ...cue, text: hostile[i % hostile.length]! }));

      const output = await new HyperFramesRenderer({ workers: 1 }).render(ir, {
        spec: resolveRenderSpec("preview", { fps: 12 }),
        workDir: work.dir,
        assetFiles: {},
      });
      expect(output.mime).toBe("video/mp4");

      expect(trap.attempts).toEqual([]);
      const leaked: string[] = [];
      for (const file of await filesUnder(work.dir)) {
        if ((await stat(file)).size > 1_000_000) continue;
        if ((await readFile(file)).includes(marker)) leaked.push(relative(work.dir, file));
      }
      expect(leaked).toEqual([]);
    });

    it("fetches no script, stylesheet, font or image and reads no host file from a compiled page", async () => {
      const { dir, cleanup } = await tempDir("egress-page");
      cleanups.push(cleanup);
      const secret = join(dir, "secret.png");
      await writeFile(secret, PNG_1X1);
      const projectDir = join(dir, "a", "b", "project");
      await mkdir(join(projectDir, "assets", "vendor"), { recursive: true });
      await copyFile(
        require.resolve("gsap/dist/gsap.min.js"),
        join(projectDir, "assets", "vendor", "gsap.min.js"),
      );
      const up = "../../../secret.png";
      await writeFile(
        join(projectDir, "index.html"),
        `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script src="assets/vendor/gsap.min.js"></script>
    <script src="https://canary.example/lib.js"></script>
    <link rel="stylesheet" href="https://canary.example/fonts.css" />
    <style>
      html, body, #root { margin: 0; width: 160px; height: 90px; overflow: hidden; background: #000; }
      .font { font-family: "Lobster", sans-serif; }
      .remote { background-image: url(https://canary.example/bg.png); }
      .host { background-image: url(${up}); }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="160" data-height="90">
      <img src="${up}" alt="" style="width: 10px" />
      <img src="https://canary.example/img.png" alt="" style="width: 10px" />
      <p class="font">Studix</p>
      <div class="remote host" style="background: url(${up}); width: 10px; height: 10px"></div>
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
      await renderWithProducer({
        projectDir,
        outputPath: join(dir, "out.mp4"),
        fps: 12,
        quality: "draft",
        crf: 30,
        workers: 1,
        logger: createLogger({ component: "compile-egress-test" }, { level: "error" }),
        onProgress: () => {},
      });

      // Copying the host file would serve it to the page; reading a system font would embed it in the render.
      // (Probing the header of a ../ image for a type check stays possible: it puts no bytes in the render.)
      const hostFiles = trap.files.filter(
        (call) =>
          (/^(copyFile|cp)/.test(call) && call.endsWith(` ${secret}`)) || call.includes(" /usr/share/fonts/"),
      );
      expect({ attempts: trap.attempts, hostFiles }).toEqual({ attempts: [], hostFiles: [] });
    });
  },
);
