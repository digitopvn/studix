import { readFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures");

export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8"));
}
