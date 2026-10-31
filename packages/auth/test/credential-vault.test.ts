import { randomBytes } from "node:crypto";
import type { SealedCredentialStore, TenantContext } from "@studix/core";
import { redact } from "@studix/shared";
import { describe, expect, it } from "vitest";
import {
  createCredentialVault,
  keyHintOf,
  openCredential,
  parseCredentialKeyring,
  sealCredential,
} from "../src/credential-vault.ts";

const key = () => randomBytes(32).toString("base64");
const ctxOf = (workspaceId: string): TenantContext => ({
  organizationId: "org_1",
  workspaceId,
  actor: { type: "user", id: "usr_1", role: "owner" },
});

function memoryStore(): SealedCredentialStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    async put(ctx, ref, sealed) {
      rows.set(`${ctx.workspaceId}/${ref}`, sealed);
    },
    async get(ctx, ref) {
      return rows.get(`${ctx.workspaceId}/${ref}`);
    },
    async delete(ctx, ref) {
      rows.delete(`${ctx.workspaceId}/${ref}`);
    },
  };
}

describe("credential keyring", () => {
  it("parses ids and 32-byte keys, first entry active", () => {
    const ring = parseCredentialKeyring(`k2:${key()}, k1:${key()}`);
    expect(ring.activeKeyId).toBe("k2");
    expect([...ring.keys.keys()]).toEqual(["k2", "k1"]);
  });

  it("rejects missing, short and duplicate keys", () => {
    expect(() => parseCredentialKeyring(undefined)).toThrow(/No credential encryption key/);
    expect(() => parseCredentialKeyring("k1:c2hvcnQ=")).toThrow(/invalid entry/);
    const k = key();
    expect(() => parseCredentialKeyring(`k1:${k},k1:${k}`)).toThrow(/invalid entry/);
  });
});

describe("sealed credentials", () => {
  const ring = parseCredentialKeyring(`k1:${key()}`);

  it("round-trips and never contains the plaintext", () => {
    const sealed = sealCredential(ring, "ws_a", "cred_1", "sk-ant-secret-value");
    expect(sealed).not.toContain("secret-value");
    expect(openCredential(ring, "ws_a", "cred_1", sealed)).toBe("sk-ant-secret-value");
  });

  it("uses a fresh IV per seal", () => {
    expect(sealCredential(ring, "ws_a", "cred_1", "x")).not.toBe(sealCredential(ring, "ws_a", "cred_1", "x"));
  });

  it("fails to open for another workspace, another reference, tampering or an unknown key", () => {
    const sealed = sealCredential(ring, "ws_a", "cred_1", "secret");
    expect(() => openCredential(ring, "ws_b", "cred_1", sealed)).toThrow(/cannot be opened/);
    expect(() => openCredential(ring, "ws_a", "cred_2", sealed)).toThrow(/cannot be opened/);
    const tampered = `${sealed.slice(0, -2)}AA`;
    expect(() => openCredential(ring, "ws_a", "cred_1", tampered)).toThrow(/cannot be opened/);
    const other = parseCredentialKeyring(`k9:${key()}`);
    expect(() => openCredential(other, "ws_a", "cred_1", sealed)).toThrow(/cannot be opened/);
  });

  it("opens old secrets after rotating the active key", () => {
    const k1 = key();
    const old = parseCredentialKeyring(`k1:${k1}`);
    const sealed = sealCredential(old, "ws_a", "cred_1", "secret");
    const rotated = parseCredentialKeyring(`k2:${key()},k1:${k1}`);
    expect(openCredential(rotated, "ws_a", "cred_1", sealed)).toBe("secret");
    expect(sealCredential(rotated, "ws_a", "cred_1", "secret").startsWith("v1.k2.")).toBe(true);
  });
});

describe("credential vault", () => {
  it("stores only ciphertext and reveals per workspace", async () => {
    const store = memoryStore();
    const vault = createCredentialVault({ store, keyring: parseCredentialKeyring(`k1:${key()}`) });
    const ref = await vault.put(ctxOf("ws_a"), "sk-live-123456789012345");
    expect(ref.startsWith("cred_")).toBe(true);
    expect([...store.rows.values()].join()).not.toContain("sk-live");
    expect(await vault.reveal(ctxOf("ws_a"), ref)).toBe("sk-live-123456789012345");
    await expect(vault.reveal(ctxOf("ws_b"), ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rotates in place and removes", async () => {
    const vault = createCredentialVault({
      store: memoryStore(),
      keyring: parseCredentialKeyring(`k1:${key()}`),
    });
    const ctx = ctxOf("ws_a");
    const ref = await vault.put(ctx, "old");
    await vault.replace(ctx, ref, "new");
    expect(await vault.reveal(ctx, ref)).toBe("new");
    await vault.remove(ctx, ref);
    await expect(vault.reveal(ctx, ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects references that are not vault refs", async () => {
    const vault = createCredentialVault({
      store: memoryStore(),
      keyring: parseCredentialKeyring(`k1:${key()}`),
    });
    await expect(vault.reveal(ctxOf("ws_a"), "env:ANTHROPIC_API_KEY")).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});

describe("opening sealed credentials", () => {
  const ring = () => parseCredentialKeyring(`k1:${key()}`);

  it("rejects a truncated auth tag, a wrong iv length and extra segments", () => {
    const keyring = ring();
    const sealed = sealCredential(keyring, "ws_a", "cred_1", "secret-value-123");
    const [v, k, iv, tag, ct] = sealed.split(".") as [string, string, string, string, string];
    const shortTag = Buffer.from(tag, "base64url").subarray(0, 4).toString("base64url");
    const shortIv = Buffer.from(iv, "base64url").subarray(0, 8).toString("base64url");
    for (const bad of [
      [v, k, iv, shortTag, ct].join("."),
      [v, k, shortIv, tag, ct].join("."),
      `${sealed}.extra`,
    ]) {
      expect(() => openCredential(keyring, "ws_a", "cred_1", bad)).toThrow(/cannot be opened/);
    }
    expect(openCredential(keyring, "ws_a", "cred_1", sealed)).toBe("secret-value-123");
  });

  it("registers each OAuth token with the redactor on reveal", async () => {
    const store = memoryStore();
    const vault = createCredentialVault({ store, keyring: ring() });
    const ctx = ctxOf("ws_a");
    const ref = await vault.put(
      ctx,
      JSON.stringify({ access_token: "at-0123456789abcdef", refresh_token: "rt-fedcba9876543210" }),
    );
    await vault.reveal(ctx, ref);
    expect(redact("log: at-0123456789abcdef and rt-fedcba9876543210")).toBe("log: [redacted] and [redacted]");
  });
});

describe("keyHintOf", () => {
  it("masks the middle and hides short secrets entirely", () => {
    expect(keyHintOf("sk-ant-api03-abcdefghijklmnop12345678abcd1234")).toBe("sk-an…1234");
    expect(keyHintOf("short")).toBe("••••");
  });
});
