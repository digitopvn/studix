import { defineConfig } from "vitest/config";

/**
 * Test projects:
 * - unit: pure tests, no external services (`*.test.ts`).
 * - integration: needs DATABASE_URL / S3_* from `docker compose up -d postgres minio` (`*.integration.test.ts`).
 * - live: calls paid third-party APIs; collected only when STUDIX_LIVE=1 (`*.live.test.ts`).
 */
const roots = ["packages/*/test", "apps/*/test", "deploy/*/test"];
const files = (suffix: string) => roots.map((root) => `${root}/**/*${suffix}`);
const liveEnabled = process.env.STUDIX_LIVE === "1";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "unit",
          include: files(".test.ts"),
          exclude: ["**/node_modules/**", "**/*.integration.test.ts", "**/*.live.test.ts"],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "integration",
          include: files(".integration.test.ts"),
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: "live",
          include: liveEnabled ? files(".live.test.ts") : [],
          testTimeout: 1_800_000,
        },
      },
    ],
  },
});
