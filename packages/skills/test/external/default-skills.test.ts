import { createInMemoryExternalSkillRepository, testTenant } from "@studix/core/testing";
import { createManualClock } from "@studix/shared";
import { InMemoryStorageAdapter } from "@studix/storage";
import { describe, expect, it } from "vitest";
import { loadDefaultSkills } from "../../src/external/default-skills.ts";
import { createExternalSkillService } from "../../src/external/external-skill-service.ts";
import { createSkillBundleSource } from "../../src/external/skill-bundle-source.ts";

describe("default skills", () => {
  it("seeds every bundled skill once, on for every workspace until one turns it off", async () => {
    const repository = createInMemoryExternalSkillRepository(createManualClock(Date.UTC(2026, 10, 7)));
    const service = createExternalSkillService({ repository, storage: new InMemoryStorageAdapter() });
    const platform = testTenant({ actor: { type: "system", id: "default-skills" } });
    const skills = await loadDefaultSkills();

    const first = await service.seedDefaults(platform, skills);
    expect(first.filter((i) => i.outcome !== "imported")).toEqual([]);
    expect(first).toHaveLength(skills.length);
    const again = await service.seedDefaults(platform, skills);
    expect(again.every((i) => i.outcome === "unchanged")).toBe(true);

    const member = testTenant({ role: "admin" });
    const source = createSkillBundleSource({ repository, service });
    const mounted = await source.listEnabled(member);
    expect(mounted.map((b) => b.name).sort()).toEqual(first.map((i) => i.name).sort());

    const dogfood = first.find((i) => i.name === "ak-dogfood")!;
    expect(await service.disable(member, { skillId: dogfood.skillId! })).toMatchObject({
      turnedOffHere: true,
    });
    expect((await source.listEnabled(member)).some((b) => b.name === "ak-dogfood")).toBe(false);
    expect((await source.listEnabled(testTenant())).some((b) => b.name === "ak-dogfood")).toBe(true);
    const listed = await service.list(member, { scope: "platform" });
    expect(listed.items.find((s) => s.id === dogfood.skillId)).toMatchObject({
      turnedOffHere: true,
      source: { kind: "default" },
    });
  });
});
