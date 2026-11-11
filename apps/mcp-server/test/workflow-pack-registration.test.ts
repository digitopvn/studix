import { testTenant } from "@studix/core/testing";
import { getSkill, registerPack, type WorkflowPack } from "@studix/skills";
import { afterEach, describe, expect, it } from "vitest";
import type { AppLimits } from "../src/app-deps.ts";
import { packStageOutputValidator, skillSummaries } from "../src/compose-integrations.ts";
import { inspectCapabilities } from "../src/mcp/inspect-capabilities.ts";

/** A pack the server has never heard of: it reuses the brand-intro template under a new id. */
const samplePack: WorkflowPack = {
  id: "sample-explainer",
  title: "Sample explainer",
  version: 1,
  templates: [
    {
      ...getSkill("brand-intro"),
      id: "sample-explainer",
      title: "Sample explainer",
      description: "Test-only pack proving that a registered pack is advertised without server changes.",
    },
  ],
};

let unregister: (() => void) | undefined;
afterEach(() => {
  unregister?.();
  unregister = undefined;
});

const BUILT_IN = [
  "brand-intro",
  "marketing-video",
  "motion-graphic",
  "anime",
  "long-form-film",
  "skill-agent",
];

describe("workflow packs on the MCP server", () => {
  it("advertises a newly registered pack through studix_inspect without code changes", () => {
    expect(skillSummaries().map((s) => s.id)).toEqual(BUILT_IN);
    unregister = registerPack(samplePack);

    const skills = skillSummaries();
    expect(skills.map((s) => s.id)).toEqual([...BUILT_IN, "sample-explainer"]);
    const capabilities = inspectCapabilities({
      tenant: testTenant(),
      limits: {} as AppLimits,
      skills,
      toolNames: [],
      include: [],
    });
    expect(capabilities.skills).toContainEqual({
      id: "sample-explainer",
      title: "Sample explainer",
      description: samplePack.templates[0]!.description,
      version: 1,
    });
  });

  it("drops the pack again once it is unregistered", () => {
    registerPack(samplePack)();
    expect(skillSummaries().map((s) => s.id)).toEqual(BUILT_IN);
  });
});

describe("host agent output validation", () => {
  it("accepts a motion-graphic storyboard in the shape the host agent is given", () => {
    const storyboard = {
      styleProfile: "saas-bento",
      beats: ["Hook", "Message", "Try it"].map((onScreen) => ({
        onScreen,
        voiceover: `${onScreen}.`,
        visual: "Big type",
        enter: "fade",
        weight: 1,
      })),
      music: null,
      brandName: "Studix",
      rationale: "Clean type for a product launch.",
    };
    const check = packStageOutputValidator()("motion-graphic.storyboard", { storyboard });
    // The host submits only the storyboard; the stage records `source` itself.
    expect(check).toMatchObject({ ok: true, output: { storyboard: { brandName: "Studix" } } });
    expect(check.ok && "source" in check.output).toBe(false);
  });
});
