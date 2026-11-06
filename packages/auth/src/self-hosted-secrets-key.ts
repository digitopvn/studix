import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { StudixConfig } from "@studix/shared";
import { parseSecretKey } from "./secret-box.ts";

/** Where a self-hosted server keeps its generated master key when STUDIX_SECRETS_KEY_FILE is unset. */
export const DEFAULT_SECRETS_KEY_FILE = ".studix/secrets.key";

/**
 * On a self-hosted server (STUDIX_SELF_HOSTED) without STUDIX_SECRETS_KEY, read the master key from
 * STUDIX_SECRETS_KEY_FILE, generating 32 random bytes there (mode 0600) on first start. The key lives in a
 * file next to the server, never in the database it protects. App and worker must see the same file.
 * Hosted deployments and an explicit STUDIX_SECRETS_KEY are returned unchanged.
 */
export function withSelfHostedSecretsKey<C extends StudixConfig>(config: C): C {
  if (config.STUDIX_SECRETS_KEY || !config.STUDIX_SELF_HOSTED) return config;
  const file = resolve(config.STUDIX_SECRETS_KEY_FILE ?? DEFAULT_SECRETS_KEY_FILE);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    // `wx` fails if the file exists, so a second process (app vs worker) reads the first one's key.
    writeFileSync(file, `${randomBytes(32).toString("base64")}\n`, { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const key = readFileSync(file, "utf8").trim();
  parseSecretKey(key);
  return { ...config, STUDIX_SECRETS_KEY: key };
}
