import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { StudixError } from "@studix/shared";

/**
 * Envelope for secrets stored at rest: AES-256-GCM with a random 96-bit IV and caller-supplied
 * associated data (workspace + record id), so a ciphertext copied to another row or tenant fails to
 * open. Format: `v1.<keyId>.<base64url(iv | tag | ciphertext)>`; `keyId` names the master key so it
 * can be rotated by adding a new key while old rows still open.
 */
export interface SecretBox {
  readonly keyId: string;
  seal(plaintext: string, associatedData: string): string;
  open(sealed: string, associatedData: string): string;
}

const VERSION = "v1";

function keyIdOf(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** Parse a base64 (or base64url) 32-byte key; VALIDATION when it is anything else. */
export function parseSecretKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new StudixError("VALIDATION", "STUDIX_SECRETS_KEY must be 32 random bytes, base64 encoded", {
      retryable: false,
      suggestedAction: "Generate one with `openssl rand -base64 32`.",
    });
  }
  return key;
}

/** `current` seals new secrets; `previous` keys only open existing ones. */
export function createSecretBox(current: Buffer, previous: readonly Buffer[] = []): SecretBox {
  const keys = new Map<string, Buffer>();
  for (const key of [current, ...previous]) keys.set(keyIdOf(key), key);
  const keyId = keyIdOf(current);
  const unreadable = () =>
    new StudixError("INTERNAL", "Stored secret cannot be opened", {
      retryable: false,
      suggestedAction: "Re-enter the credential; the stored copy is unreadable with the current keys.",
    });
  return {
    keyId,
    seal(plaintext, associatedData) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", current, iv);
      cipher.setAAD(Buffer.from(associatedData, "utf8"));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const blob = Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
      return `${VERSION}.${keyId}.${blob}`;
    },
    open(sealed, associatedData) {
      const [version, id, blob] = sealed.split(".");
      const key = id ? keys.get(id) : undefined;
      if (version !== VERSION || !key || !blob) throw unreadable();
      const raw = Buffer.from(blob, "base64url");
      if (raw.length < 29) throw unreadable();
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
        decipher.setAAD(Buffer.from(associatedData, "utf8"));
        decipher.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
      } catch {
        throw unreadable();
      }
    },
  };
}
