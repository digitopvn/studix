import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testTenant } from "@studix/core/testing";
import { describe, expect, it } from "vitest";
import { createAgentArtifactStore } from "../src/agent-artifact-store.ts";

describe("agent artifact store", () => {
  it("turns a media output into a project asset with a signed URL and skips other files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "studix-art-"));
    const mp4 = join(dir, "hero.mp4");
    await writeFile(mp4, "video");
    await writeFile(join(dir, "notes.txt"), "text");
    const puts: string[] = [];
    const versions: unknown[] = [];
    const store = createAgentArtifactStore({
      storage: {
        put: async (_ctx, key) => {
          puts.push(key);
          return { key, bytes: 5, sha256: "x", contentType: "video/mp4" };
        },
        signedUrl: async (_ctx, key) => `https://store.test/${key}?sig=1`,
      },
      assets: {
        create: async (_ctx, input) => ({ id: "ast_1", ...input }) as never,
        addVersion: async (_ctx, input) => {
          versions.push(input);
          return { id: "ver_1" } as never;
        },
      },
    });
    const stage = { job: { id: "job_1", projectId: "prj_1" }, attempt: 1 } as never;

    const stored = await store(testTenant(), stage, mp4);
    expect(stored).toEqual({
      assetId: "ast_1",
      storageKey: "assets/ast_1/v1/hero.mp4",
      url: "https://store.test/assets/ast_1/v1/hero.mp4?sig=1",
      contentType: "video/mp4",
    });
    expect(puts).toEqual(["assets/ast_1/v1/hero.mp4"]);
    expect(versions).toMatchObject([{ assetId: "ast_1", mime: "video/mp4", bytes: 5 }]);
    expect(await store(testTenant(), stage, join(dir, "notes.txt"))).toBeUndefined();
  });
});
