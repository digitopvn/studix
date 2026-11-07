// Forced-aligns every voice-over clip against its spoken text (ElevenLabs align via multix)
// and writes data/vo-lines.json: per scene, per line start/end in clip-local seconds.
// Usage: node scripts/align-voiceover.mjs [--force]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: node scripts/align-voiceover.mjs [--force]\n  --force  re-align scenes that already have data/align/<id>.json");
  process.exit(0);
}
process.on("uncaughtException", (e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
// A missing input stops with one line naming the step that creates it.
const need = (p, hint) => {
  if (existsSync(p)) return p;
  console.error(`error: ${p} not found; ${hint}`);
  process.exit(1);
};
const example = (name) => `start from <skill>/assets/templates/data/${name}.example.json`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = JSON.parse(readFileSync(need(join(root, "data/script.json"), example("script")), "utf8"));
const force = process.argv.includes("--force");
const alignDir = join(root, "data/align");
const workDir = join(os.tmpdir(), `${basename(root)}-multix`);
mkdirSync(alignDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

// POSIX spawns multix without a shell so spoken text never meets $, ` or globbing.
// Windows needs cmd.exe to resolve the multix.cmd shim: double embedded quotes and
// caret-escape % outside the quotes so %VAR% in a script line stays literal.
const isWin = process.platform === "win32";
const cmdQuote = (v) => `"${String(v).replace(/"/g, '""').replace(/%/g, '"^%"')}"`;
const spawnMultix = (argv, cwd) =>
  isWin ? spawn("multix", argv.map(cmdQuote), { shell: true, cwd }) : spawn("multix", argv, { cwd });
const run = (argv) =>
  new Promise((ok, fail) => {
    const child = spawnMultix(argv, workDir);
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? ok(log) : fail(new Error(log.slice(-600)))));
  });

const spoken = (line) => line.say || line.en;
const tokens = (text) => text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t));

// Check every clip up front so a missing one never stops the run with multix calls in flight.
for (const s of script.scenes) {
  if (force || !existsSync(join(alignDir, `${s.id}.json`))) need(join(root, `assets/audio/vo/${s.id}.wav`), "run generate-audio-assets.mjs vo");
}
const queue = [...script.scenes];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const s = queue.shift();
      const out = join(alignDir, `${s.id}.json`);
      if (existsSync(out) && !force) continue;
      const text = s.lines.map(spoken).join(" ");
      await run(["elevenlabs", "align", "--input", join(root, `assets/audio/vo/${s.id}.wav`), "--text", text, "--output", out]);
      console.log(`aligned ${s.id}`);
    }
  }),
);

// Map aligned words back onto script lines by token count (alignment keeps text order).
const result = {};
for (const s of script.scenes) {
  const align = JSON.parse(readFileSync(join(alignDir, `${s.id}.json`), "utf8"));
  const words = align.words.filter((w) => /[\p{L}\p{N}]/u.test(w.text));
  let i = 0;
  const lines = s.lines.map((line) => {
    const n = tokens(spoken(line)).length;
    const seg = words.slice(i, i + n);
    i += n;
    return { start: seg[0].start, end: seg[seg.length - 1].end, words: seg.map((w) => ({ t: w.text, s: w.start, e: w.end })) };
  });
  if (i !== words.length) console.warn(`${s.id}: ${words.length} aligned words vs ${i} script tokens`);
  result[s.id] = { speechStart: lines[0].start, speechEnd: lines[lines.length - 1].end, lines };
}
writeFileSync(join(root, "data/vo-lines.json"), JSON.stringify(result, null, 1));
for (const [id, v] of Object.entries(result)) console.log(id, v.speechStart.toFixed(2), v.speechEnd.toFixed(2), v.lines.map((l) => `${l.start.toFixed(2)}-${l.end.toFixed(2)}`).join(" | "));
