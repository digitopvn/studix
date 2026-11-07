import { describe, expect, it } from "vitest";
import { withTestDatabase } from "../src/testing/index.ts";

const db = withTestDatabase();
const by = { type: "user", id: "usr_op" } as const;

describe("platform credential repository", () => {
  it("inserts, then replaces in place with a higher version and no stale test", async () => {
    const { platformCredentials } = db.current.repos;
    const first = await platformCredentials.upsert(
      { name: "SUME_API_KEY", secretCiphertext: "v1.k.aaa", secretHint: "…1111" },
      by,
    );
    expect(first).toMatchObject({ version: 1, secretHint: "…1111", updatedBy: by });

    expect(await platformCredentials.recordTest("SUME_API_KEY", { ok: true, at: new Date() })).toBe(true);
    expect((await platformCredentials.list())[0]?.lastTest?.ok).toBe(true);

    const second = await platformCredentials.upsert(
      { name: "SUME_API_KEY", secretCiphertext: "v1.k.bbb", secretHint: "…2222" },
      { type: "user", id: "usr_other" },
    );
    expect(second).toMatchObject({
      version: 2,
      secretCiphertext: "v1.k.bbb",
      updatedBy: { id: "usr_other" },
    });
    expect(second.lastTest).toBeUndefined();
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
    expect(await platformCredentials.list()).toHaveLength(1);
  });

  it("lists by name, deletes and reports a missing row", async () => {
    const { platformCredentials } = db.current.repos;
    // The database is shared by the tests of this file: start from an empty table.
    await platformCredentials.delete("SUME_API_KEY");
    for (const name of ["FISH_API_KEY", "ATLASCLOUD_API_KEY"]) {
      await platformCredentials.upsert({ name, secretCiphertext: "v1.k.x", secretHint: "…xxxx" }, by);
    }
    expect((await platformCredentials.list()).map((r) => r.name)).toEqual([
      "ATLASCLOUD_API_KEY",
      "FISH_API_KEY",
    ]);
    expect(await platformCredentials.delete("FISH_API_KEY")).toBe(true);
    expect(await platformCredentials.delete("FISH_API_KEY")).toBe(false);
    expect(await platformCredentials.recordTest("FISH_API_KEY", { ok: false, at: new Date() })).toBe(false);
  });
});
