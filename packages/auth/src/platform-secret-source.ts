import type { PlatformSecretRepository } from "@studix/database";
import {
  type Logger,
  PLATFORM_MEDIA_ENV_NAMES,
  registerSecret,
  STORAGE_CREDENTIALS_NAME,
  type StorageCredentialPair,
  StudixError,
} from "@studix/shared";
import type { SecretBox } from "./secret-box.ts";

/** How long a value read from the database is reused; a rotation reaches every process within this time. */
export const PLATFORM_SECRET_REFRESH_MS = 15_000;

/** Associated data binding a sealed value to its row name, so a ciphertext cannot be moved to another name. */
export function platformSecretAad(name: string): string {
  return `platform:${name}`;
}

export function parseStoragePair(plaintext: string): StorageCredentialPair {
  const raw = JSON.parse(plaintext) as Partial<StorageCredentialPair>;
  if (typeof raw.accessKeyId !== "string" || typeof raw.secretAccessKey !== "string") {
    throw new Error("malformed storage credentials");
  }
  return { accessKeyId: raw.accessKeyId, secretAccessKey: raw.secretAccessKey };
}

export interface PlatformSecretSource {
  /**
   * Environment the Multix provider reads on every call: the process environment with the dashboard's media
   * keys laid over it. Mutated in place by `refresh`, so hand this exact object to the provider.
   */
  readonly mediaEnv: Record<string, string | undefined>;
  /** Active storage credentials: the dashboard's pair when one is stored, else the environment's. */
  storageCredentials(): Promise<StorageCredentialPair>;
  /** Re-read the database now (the dashboard calls this after a save so its own process updates at once). */
  refresh(): Promise<void>;
  /** Refresh on a timer until the returned function is called; the timer never keeps the process alive. */
  start(): () => void;
}

export interface PlatformSecretSourceOptions {
  secrets: PlatformSecretRepository;
  /** Without a box nothing stored can be opened, so the source is the plain environment. */
  box?: SecretBox;
  /** The deployment's environment: the fallback for every variable and the source of unmanaged ones. */
  base: Readonly<Record<string, string | undefined>>;
  logger?: Logger;
  refreshMs?: number;
}

/**
 * The one place that turns stored platform secrets into the values processes use. The app and the worker
 * each build one over the same table, so both follow a dashboard change without a restart. Values are
 * registered with the log redactor as soon as they are opened. A read or decrypt failure keeps the last
 * good value (or the environment's) and logs the name only.
 */
export function createPlatformSecretSource(options: PlatformSecretSourceOptions): PlatformSecretSource {
  const { secrets, box, base, logger } = options;
  const refreshMs = options.refreshMs ?? PLATFORM_SECRET_REFRESH_MS;
  const env: Record<string, string | undefined> = { ...base };
  let storage: StorageCredentialPair | undefined;
  let pending: Promise<void> | undefined;

  const warn = (message: string, name?: string) => logger?.warn(message, name ? { secret: name } : undefined);

  async function load(): Promise<void> {
    if (!box) return;
    let rows: Awaited<ReturnType<PlatformSecretRepository["list"]>>;
    try {
      rows = await secrets.list();
    } catch {
      warn("platform secrets could not be read; keeping the values in use");
      return;
    }
    const byName = new Map(rows.map((row) => [row.name, row]));
    for (const name of PLATFORM_MEDIA_ENV_NAMES) {
      const row = byName.get(name);
      let value = base[name];
      if (row) {
        try {
          value = box.open(row.secretCiphertext, platformSecretAad(name));
          registerSecret(value);
        } catch {
          warn("a stored platform secret cannot be opened; using the environment value", name);
        }
      }
      env[name] = value;
    }
    const pair = byName.get(STORAGE_CREDENTIALS_NAME);
    storage = undefined;
    if (pair) {
      try {
        storage = parseStoragePair(box.open(pair.secretCiphertext, platformSecretAad(pair.name)));
        registerSecret(storage.accessKeyId);
        registerSecret(storage.secretAccessKey);
      } catch {
        warn("stored storage credentials cannot be opened; using the environment value", pair.name);
      }
    }
  }

  const refresh = () => {
    pending ??= load().finally(() => {
      pending = undefined;
    });
    return pending;
  };

  return {
    mediaEnv: env,
    async storageCredentials() {
      if (storage) return storage;
      const accessKeyId = base.S3_ACCESS_KEY_ID;
      const secretAccessKey = base.S3_SECRET_ACCESS_KEY;
      if (accessKeyId && secretAccessKey) return { accessKeyId, secretAccessKey };
      throw new StudixError("UNAVAILABLE", "No object storage credentials are configured", {
        retryable: false,
        suggestedAction:
          "Store the access key in Settings → Storage & Media, or set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.",
      });
    },
    refresh,
    start() {
      const timer = setInterval(() => void refresh(), refreshMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
