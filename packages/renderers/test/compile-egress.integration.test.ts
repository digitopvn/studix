import dns from "node:dns";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { join, relative } from "node:path";
import { resolveRenderSpec } from "@studix/video-ir";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HyperFramesRenderer } from "../src/index.ts";
import { loadIrFixture, renderToolchain, tempDir } from "./render-test-helpers.ts";

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
 * Every outbound DNS lookup, HTTP(S) request, fetch and TCP connect the render process makes to a host that
 * is not loopback is recorded and refused, so nothing really leaves the machine while the test runs.
 */
function trapEgress(): { attempts: string[]; restore: () => void } {
  const attempts: string[] = [];
  const restores: (() => void)[] = [];
  const refuse = (kind: string, host: string) => {
    attempts.push(`${kind} ${host}`);
    return new Error(`test blocked ${kind} to ${host}`);
  };
  const wrap = <T extends object>(obj: T, key: keyof T, kind: string, hostArg: (args: unknown[]) => unknown) => {
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
  syncBuiltinESMExports();
  return {
    attempts,
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
  },
);
