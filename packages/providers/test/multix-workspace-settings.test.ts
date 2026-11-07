import type { TenantContext } from "@studix/core";
import { describe, expect, it } from "vitest";
import {
  assertMultixOverrides,
  createWorkspaceMultixProviders,
  type MultixConfig,
  type MultixWorkspaceOverrides,
  multixConfigFor,
} from "../src/index.ts";

const config = {
  MULTIX_BIN: "multix",
  MULTIX_ALLOW_HOME_ENV: false,
  MULTIX_WAIT_TIMEOUT_SECONDS: 900,
  MULTIX_VOICE_MODEL: "elevenlabs:eleven_multilingual_v2",
} as MultixConfig;
const none: MultixWorkspaceOverrides = {
  enabled: null,
  waitTimeoutSeconds: null,
  models: {},
  voiceLanguageModels: null,
};
const ctx = (workspaceId: string) => ({ organizationId: "org_1", workspaceId }) as TenantContext;

describe("multixConfigFor", () => {
  it("applies each saved field and keeps the server value of the others", () => {
    const next = multixConfigFor(config, {
      ...none,
      waitTimeoutSeconds: 120,
      models: { video: "sume:seedance-2" },
    });
    expect(next.MULTIX_WAIT_TIMEOUT_SECONDS).toBe(120);
    expect(next.MULTIX_VIDEO_MODEL).toBe("sume:seedance-2");
    expect(next.MULTIX_VOICE_MODEL).toBe(config.MULTIX_VOICE_MODEL);
    expect(next.MULTIX_BIN).toBe("multix");
  });

  it("turns Multix off for the workspace, but cannot turn on a server without the CLI", () => {
    expect(multixConfigFor(config, { ...none, enabled: false }).MULTIX_BIN).toBeUndefined();
    const noCli = { ...config, MULTIX_BIN: undefined };
    expect(multixConfigFor(noCli, { ...none, enabled: true }).MULTIX_BIN).toBeUndefined();
  });
});

describe("assertMultixOverrides", () => {
  it("accepts a known model of the role", () => {
    expect(() =>
      assertMultixOverrides(config, { ...none, models: { music: "minimax:music-2.0" } }),
    ).not.toThrow();
  });

  it("rejects an unknown role, a model of the wrong vendor and a bad voice route", () => {
    expect(() => assertMultixOverrides(config, { ...none, models: { poster: "sume:x" } })).toThrow(
      /Unknown Multix role/,
    );
    expect(() => assertMultixOverrides(config, { ...none, models: { sfx: "sume:x" } })).toThrow(
      /Invalid Multix settings/,
    );
    expect(() => assertMultixOverrides(config, { ...none, voiceLanguageModels: "not a route" })).toThrow(
      /Invalid Multix settings/,
    );
  });
});

describe("createWorkspaceMultixProviders", () => {
  it("uses the server provider when the workspace saved nothing or nothing different", async () => {
    const saved = new Map<string, MultixWorkspaceOverrides>([["ws_same", none]]);
    const providers = createWorkspaceMultixProviders({ config, load: async (c) => saved.get(c.workspaceId) });
    expect(await providers.forWorkspace(ctx("ws_new"))).toBe(providers.server);
    expect(await providers.forWorkspace(ctx("ws_same"))).toBe(providers.server);
  });

  it("builds one provider per distinct setting and shares it between equal workspaces", async () => {
    const providers = createWorkspaceMultixProviders({
      config,
      load: async () => ({ ...none, enabled: false }),
    });
    const a = await providers.forWorkspace(ctx("ws_a"));
    expect(a).not.toBe(providers.server);
    expect(a.enabled).toBe(false);
    expect(await providers.forWorkspace(ctx("ws_b"))).toBe(a);
  });

  it("falls back to the server provider when the settings cannot be read or no longer validate", async () => {
    const failing = createWorkspaceMultixProviders({
      config,
      load: async () => {
        throw new Error("db down");
      },
    });
    expect(await failing.forWorkspace(ctx("ws_a"))).toBe(failing.server);
    const stale = createWorkspaceMultixProviders({
      config,
      load: async () => ({ ...none, models: { sfx: "sume:x" } }),
    });
    expect(await stale.forWorkspace(ctx("ws_a"))).toBe(stale.server);
  });
});
