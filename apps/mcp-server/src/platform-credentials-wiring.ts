import type { PlatformMediaPort, PlatformStoragePort, StorageProbeOutcome } from "@studix/auth";
import type { MultixProvider } from "@studix/providers";
import { createS3StorageAdapterFromConfig, type S3StorageAdapter } from "@studix/storage";

type StorageConfig = Parameters<typeof createS3StorageAdapterFromConfig>[0];

/** Display-safe origin: an endpoint can carry a path, and only the host is useful to an operator. */
function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

async function timed(
  run: () => Promise<Omit<StorageProbeOutcome, "latencyMs">>,
): Promise<StorageProbeOutcome> {
  const started = Date.now();
  const outcome = await run();
  return { ...outcome, latencyMs: Date.now() - started };
}

/**
 * Storage as the credential service sees it: the configured bucket (no secrets) and a write/read/head/delete
 * probe. A candidate key pair is tried on a short-lived adapter against the same bucket and endpoint, so the
 * active adapter keeps serving traffic until the new pair has proved itself.
 */
export function createPlatformStoragePort(
  config: StorageConfig,
  active: Pick<S3StorageAdapter, "probeWrite">,
): PlatformStoragePort {
  return {
    describe: () => ({
      ...(originOf(config.S3_ENDPOINT) ? { endpoint: originOf(config.S3_ENDPOINT)! } : {}),
      ...(originOf(config.S3_PUBLIC_ENDPOINT)
        ? { publicEndpoint: originOf(config.S3_PUBLIC_ENDPOINT)! }
        : {}),
      bucket: config.S3_BUCKET!,
      region: config.S3_REGION,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      signedUrlTtlSeconds: config.S3_SIGNED_URL_TTL_SECONDS,
    }),
    probe: (candidate) =>
      timed(async () => {
        if (!candidate) return active.probeWrite();
        const adapter = createS3StorageAdapterFromConfig(config, { credentials: candidate });
        try {
          return await adapter.probeWrite();
        } finally {
          adapter.destroy();
        }
      }),
  };
}

export function createPlatformMediaPort(provider: MultixProvider | undefined): PlatformMediaPort {
  return {
    executable: () =>
      provider?.enabled
        ? { configured: true, ...(provider.executablePath ? { path: provider.executablePath } : {}) }
        : {
            configured: false,
            reason:
              "MULTIX_BIN is not set on the app process. The worker is authoritative for media generation: see its /readyz.",
          },
    check: async () => ({ found: provider ? await provider.checkKeys() : [] }),
  };
}
