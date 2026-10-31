import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SealedCredentialStore, TenantContext } from "@studix/core";
import { newId, registerSecret, StudixError } from "@studix/shared";

/*
 * Encrypted storage for outbound AI provider credentials (API keys, OAuth token sets).
 *
 * Sealed format: `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url parts), AES-256-GCM. The additional
 * authenticated data binds each ciphertext to its workspace and secretRef, so a row copied to another
 * tenant or another reference fails to open instead of leaking.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SECRET_REF_PREFIX = "cred_";

export interface CredentialKeyring {
  /** Key new secrets are sealed with. */
  activeKeyId: string;
  /** Every key that may open existing secrets (includes the active one); enables rotation. */
  keys: ReadonlyMap<string, Buffer>;
}

/**
 * Parse `STUDIX_CREDENTIAL_KEYS`: `id:base64key[,id:base64key...]`, the first entry active. Each key is
 * 32 random bytes, e.g. `openssl rand -base64 32`.
 */
export function parseCredentialKeyring(spec: string | undefined): CredentialKeyring {
  const entries = (spec ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new StudixError("UNAVAILABLE", "No credential encryption key is configured", {
      retryable: false,
      suggestedAction: "Set STUDIX_CREDENTIAL_KEYS=<id>:<base64 32-byte key> (openssl rand -base64 32).",
    });
  }
  const keys = new Map<string, Buffer>();
  for (const entry of entries) {
    const separator = entry.indexOf(":");
    const keyId = entry.slice(0, separator);
    const key = Buffer.from(entry.slice(separator + 1), "base64");
    if (
      separator < 1 ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(keyId) ||
      key.length !== KEY_BYTES ||
      keys.has(keyId)
    ) {
      throw new StudixError("VALIDATION", "STUDIX_CREDENTIAL_KEYS has an invalid entry", {
        suggestedAction: "Use unique ids (A-Z a-z 0-9 _ -) and base64 keys of exactly 32 bytes.",
      });
    }
    registerSecret(entry.slice(separator + 1));
    keys.set(keyId, key);
  }
  return { activeKeyId: entries[0]!.slice(0, entries[0]!.indexOf(":")), keys };
}

const b64 = (buffer: Buffer): string => buffer.toString("base64url");

function aad(workspaceId: string, secretRef: string): Buffer {
  return Buffer.from(`${workspaceId}\u0000${secretRef}`, "utf8");
}

export function sealCredential(
  keyring: CredentialKeyring,
  workspaceId: string,
  secretRef: string,
  plaintext: string,
): string {
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key) throw new StudixError("INTERNAL", "Active credential key is missing from the keyring");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(workspaceId, secretRef));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", keyring.activeKeyId, b64(iv), b64(cipher.getAuthTag()), b64(ciphertext)].join(".");
}

export function openCredential(
  keyring: CredentialKeyring,
  workspaceId: string,
  secretRef: string,
  sealed: string,
): string {
  const parts = sealed.split(".");
  const [version, keyId, iv, tag, ciphertext] = parts;
  const key = keyId ? keyring.keys.get(keyId) : undefined;
  const ivBytes = Buffer.from(iv ?? "", "base64url");
  const tagBytes = Buffer.from(tag ?? "", "base64url");
  if (
    parts.length !== 5 ||
    version !== "v1" ||
    !key ||
    !ciphertext ||
    ivBytes.length !== IV_BYTES ||
    tagBytes.length !== TAG_BYTES
  ) {
    throw new StudixError("UNAVAILABLE", "Stored credential cannot be opened", { retryable: false });
  }
  try {
    // A truncated GCM tag still verifies in Node unless the length is pinned, so pin it.
    const decipher = createDecipheriv(ALGORITHM, key, ivBytes, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(workspaceId, secretRef));
    decipher.setAuthTag(tagBytes);
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    // Wrong tenant, wrong reference, wrong key or tampering all look the same on purpose.
    throw new StudixError("UNAVAILABLE", "Stored credential cannot be opened", { retryable: false });
  }
}

export interface CredentialVault {
  /** Seal and store; returns the opaque reference to keep on the connection record. */
  put(ctx: TenantContext, plaintext: string): Promise<string>;
  /** Replace the secret behind an existing reference (rotate, OAuth refresh). */
  replace(ctx: TenantContext, secretRef: string, plaintext: string): Promise<void>;
  /** Decrypt for execution only. Registers the value with the log redactor. */
  reveal(ctx: TenantContext, secretRef: string): Promise<string>;
  remove(ctx: TenantContext, secretRef: string): Promise<void>;
}

export function createCredentialVault(options: {
  store: SealedCredentialStore;
  keyring: CredentialKeyring;
}): CredentialVault {
  const { store, keyring } = options;
  const checkRef = (secretRef: string) => {
    if (!secretRef.startsWith(SECRET_REF_PREFIX)) {
      throw new StudixError("VALIDATION", "Unsupported credential reference");
    }
  };
  return {
    async put(ctx, plaintext) {
      const secretRef = newId("cred");
      await store.put(ctx, secretRef, sealCredential(keyring, ctx.workspaceId, secretRef, plaintext));
      return secretRef;
    },
    async replace(ctx, secretRef, plaintext) {
      checkRef(secretRef);
      await store.put(ctx, secretRef, sealCredential(keyring, ctx.workspaceId, secretRef, plaintext));
    },
    async reveal(ctx, secretRef) {
      checkRef(secretRef);
      const sealed = await store.get(ctx, secretRef);
      if (!sealed) throw new StudixError("NOT_FOUND", "Credential not found");
      const plaintext = openCredential(keyring, ctx.workspaceId, secretRef, sealed);
      registerSecret(plaintext);
      for (const token of oauthTokenValues(plaintext)) registerSecret(token);
      return plaintext;
    },
    async remove(ctx, secretRef) {
      checkRef(secretRef);
      await store.delete(ctx, secretRef);
    },
  };
}

/** OAuth token sets are JSON; their individual tokens must reach the redactor, not only the blob. */
function oauthTokenValues(plaintext: string): string[] {
  if (!plaintext.startsWith("{")) return [];
  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (typeof parsed !== "object" || parsed === null) return [];
    return Object.values(parsed).filter((v): v is string => typeof v === "string" && v.length >= 8);
  } catch {
    return [];
  }
}

/**
 * Display hint that never reveals the secret: a short prefix plus the last 4 for long keys, or just dots.
 * Short secrets show nothing because each revealed character is lost entropy.
 */
export function keyHintOf(secret: string): string {
  if (secret.length < 32) return "••••";
  return `${secret.slice(0, 5)}…${secret.slice(-4)}`;
}
