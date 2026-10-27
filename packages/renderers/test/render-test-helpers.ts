import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unwrapValidation, type VideoIR, validateVideoIR } from "@studix/video-ir";

export { renderToolchain } from "../src/index.ts";

const require = createRequire(import.meta.url);

/** A golden fixture from @studix/video-ir, validated. */
export function loadIrFixture(name: string): VideoIR {
  const path = require.resolve(`@studix/video-ir/fixtures/${name}.json`);
  return unwrapValidation(validateVideoIR(JSON.parse(readFileSync(path, "utf8"))), `fixture ${name}`);
}

/** Smallest valid PNG (1x1, opaque). */
export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

export async function tempDir(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), `studix-${prefix}-`));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function writePng(dir: string, name: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, PNG_1X1);
  return path;
}
