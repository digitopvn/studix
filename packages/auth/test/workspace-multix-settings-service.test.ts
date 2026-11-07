import type { Actor, AuditEvent, AuditRepository, TenantContext } from "@studix/core";
import type { WorkspaceMultixSettingsRecord, WorkspaceMultixSettingsRepository } from "@studix/database";
import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { createWorkspaceMultixSettingsService } from "../src/workspace-multix-settings-service.ts";

const ctxOf = (actor: Actor, workspaceId = "ws_1"): TenantContext => ({
  organizationId: "org_1",
  workspaceId,
  actor,
});
const owner = ctxOf({ type: "user", id: "usr_owner", role: "owner" });
const viewer = ctxOf({ type: "user", id: "usr_view", role: "viewer" });

function setup() {
  const rows = new Map<string, WorkspaceMultixSettingsRecord>();
  const settings: WorkspaceMultixSettingsRepository = {
    async get(ctx) {
      return rows.get(ctx.workspaceId);
    },
    async put(ctx, values, by) {
      const row = { ...values, updatedBy: by, updatedAt: new Date("2026-11-07T00:00:00Z") };
      rows.set(ctx.workspaceId, row);
      return row;
    },
  };
  const events: AuditEvent[] = [];
  const audit = {
    append: async (_ctx: TenantContext, event: AuditEvent) => {
      events.push(event);
    },
  } as unknown as AuditRepository;
  const service = createWorkspaceMultixSettingsService({
    settings,
    audit,
    server: {
      enabled: true,
      waitTimeoutSeconds: 900,
      models: { image: "sume:nano-banana-2.1", voice: "elevenlabs:eleven_multilingual_v2" },
      voiceLanguageModels: null,
    },
    validate: (values) => {
      if (values.models.image === "sume:broken") throw new StudixError("VALIDATION", "bad model");
    },
  });
  return { service, events };
}

describe("workspace Multix settings", () => {
  it("shows the server settings until the workspace saves its own", async () => {
    const { service } = setup();
    const view = await service.view(viewer);
    expect(view.workspace).toBeNull();
    expect(view.canChange).toBe(false);
    expect(view.effective.models.image).toEqual({ value: "sume:nano-banana-2.1", source: "server" });
    expect(view.effective.enabled).toEqual({ value: true, source: "server" });
  });

  it("lets the workspace win field by field, and audits the change", async () => {
    const { service, events } = setup();
    const view = await service.update(owner, {
      models: { image: "sume:seedream-4" },
      waitTimeoutSeconds: 300,
    });
    expect(view.canChange).toBe(true);
    expect(view.effective.models.image).toEqual({ value: "sume:seedream-4", source: "workspace" });
    expect(view.effective.models.voice?.source).toBe("server");
    expect(view.effective.waitTimeoutSeconds).toEqual({ value: 300, source: "workspace" });
    expect(events.map((e) => e.action)).toEqual(["multix_settings.updated"]);
  });

  it("keeps workspaces apart", async () => {
    const { service } = setup();
    await service.update(owner, { enabled: false });
    const other = await service.view(ctxOf({ type: "user", id: "usr_owner", role: "owner" }, "ws_2"));
    expect(other.effective.enabled.value).toBe(true);
  });

  it("refuses members without member:manage, unknown fields and invalid values", async () => {
    const { service } = setup();
    await expect(service.update(viewer, { enabled: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.update(owner, { bin: "/tmp/other-cli" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(service.update(owner, { waitTimeoutSeconds: 5 })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(service.update(owner, { models: { image: "sume:broken" } })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("reset returns every field to the server value", async () => {
    const { service, events } = setup();
    await service.update(owner, { models: { image: "sume:seedream-4" } });
    const view = await service.reset(owner);
    expect(view.effective.models.image?.source).toBe("server");
    expect(events.at(-1)?.action).toBe("multix_settings.reset");
  });
});
