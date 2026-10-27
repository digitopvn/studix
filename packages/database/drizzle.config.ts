import { defineConfig } from "drizzle-kit";

/** `pnpm db:generate` diffs src/schema against migrations/ and writes the next SQL migration. */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  strict: true,
  verbose: true,
});
