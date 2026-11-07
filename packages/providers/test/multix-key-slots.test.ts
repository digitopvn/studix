import { describe, expect, it } from "vitest";
import {
  keyReadiness,
  MULTIX_ENV_KEY_NAMES,
  MULTIX_KEY_NAMES,
  MULTIX_KEY_SLOTS,
} from "../src/multix-key-slots.ts";
import { MULTIX_VENDOR_KEYS, MULTIX_VENDORS } from "../src/multix-routes.ts";

describe("multix key slots", () => {
  it("lists every provider multix reads a key for, each further key as its own slot", () => {
    const ids = MULTIX_KEY_SLOTS.map((s) => s.id);
    for (const id of ["sume", "atlas", "gemini", "openai", "fal", "replicate", "runway", "topview"]) {
      expect(ids).toContain(id);
    }
    expect(MULTIX_KEY_NAMES.cloudflare).toBe("CLOUDFLARE_ACCOUNT_ID");
    expect(MULTIX_KEY_NAMES["cloudflare-api-token"]).toBe("CLOUDFLARE_API_TOKEN");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps alternatives out of storage but lets them reach multix", () => {
    const replicate = MULTIX_KEY_SLOTS.find((s) => s.id === "replicate");
    expect(replicate).toMatchObject({ keyName: "REPLICATE_API_TOKEN", aliases: ["REPLICATE_API_KEY"] });
    expect(Object.values(MULTIX_KEY_NAMES)).not.toContain("REPLICATE_API_KEY");
    expect(MULTIX_ENV_KEY_NAMES).toContain("REPLICATE_API_KEY");
  });

  it("derives the routed vendors' keys and counts an alternative as present", () => {
    for (const vendor of MULTIX_VENDORS) expect(MULTIX_VENDOR_KEYS[vendor]).toBe(MULTIX_KEY_NAMES[vendor]);
    expect(keyReadiness(new Set(["ARK_API_KEY", "SUME_API_KEY"]))).toMatchObject({
      byteplus: true,
      sume: true,
      atlas: false,
    });
  });
});
