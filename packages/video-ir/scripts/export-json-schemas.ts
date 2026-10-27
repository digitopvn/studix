import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportJsonSchemas } from "../src/index.ts";

/** Writes packages/video-ir/schemas/<name>.schema.json; a unit test fails when these drift. */
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  for (const file of await readdir(outDir)) {
    if (file.endsWith(".schema.json")) await rm(join(outDir, file));
  }
  const schemas = exportJsonSchemas();
  for (const [name, schema] of Object.entries(schemas)) {
    await writeFile(join(outDir, `${name}.schema.json`), `${JSON.stringify(schema, null, 2)}\n`);
  }
  process.stdout.write(`wrote ${Object.keys(schemas).length} schemas to ${outDir}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
