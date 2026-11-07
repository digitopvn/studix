import type {
  PutObjectOptions,
  SignedUploadUrlOptions,
  SignedUrlOptions,
  StorageAdapter,
  StorageBody,
  StoredObject,
  TenantContext,
} from "@studix/core";
import { type Logger, type StudixConfig, StudixError } from "@studix/shared";
import { type EndpointPolicy, guardedLookup } from "./endpoint-guard.ts";
import {
  createS3StorageAdapterFromConfig,
  type S3CredentialSource,
  S3StorageAdapter,
  type S3StorageOptions,
  type StorageProbeResult,
} from "./s3-storage-adapter.ts";
import type { SignedUrlPolicy } from "./signed-url-options.ts";

/*
 * Object storage spread over storage profiles. New objects go to the active profile; an object is read from
 * the profile its database row records, so a bucket an operator switched away from stays readable and its
 * signed URLs keep working. Profiles are re-read every `refreshMs`, so app and worker follow a switch
 * without a redeploy. The deployment environment's S3_* settings are the `env` profile, active while no
 * stored profile is.
 */

/** Id of the profile built from the S3_* environment settings. */
export const ENV_STORAGE_PROFILE_ID = "env";

export interface StorageProfileTarget {
  id: string;
  /** Changes whenever the profile's endpoint, bucket, prefix or key pair changes; the client is then rebuilt. */
  revision: string;
  options: S3StorageOptions;
}

export interface StorageProfileSnapshot {
  /** Id of the profile new objects go to (`env` when no stored profile is active). */
  activeId: string;
  /** Every readable stored profile, active or not. The `env` profile is not listed here. */
  profiles: readonly StorageProfileTarget[];
}

export interface ProfileStorageRouterOptions {
  /** The `env` profile; absent when S3_BUCKET is not set. */
  fallback?: S3StorageAdapter;
  load: () => Promise<StorageProfileSnapshot>;
  /** The profile a stored object's row records (asset version or render), when it has one. */
  locate?: (ctx: TenantContext, key: string) => Promise<string | undefined>;
  refreshMs?: number;
  /** Media origins of the `env` profile, for the dashboard CSP. */
  fallbackOrigins?: string[];
  logger?: Logger;
  now?: () => number;
}

export const STORAGE_PROFILE_REFRESH_MS = 20_000;
/** Replaced clients are released after this long, so requests already running on them can finish. */
const RETIRE_AFTER_MS = 10 * 60_000;
const LOCATION_CACHE_LIMIT = 5_000;

interface Built {
  id: string;
  revision: string;
  adapter: S3StorageAdapter;
  origins: string[];
}

function originsOf(options: S3StorageOptions): string[] {
  const endpoint = options.publicEndpoint ?? options.endpoint;
  if (!endpoint) {
    return [`https://${options.bucket}.s3.${options.region}.amazonaws.com`, "https://s3.amazonaws.com"];
  }
  const url = new URL(endpoint);
  return options.forcePathStyle ? [url.origin] : [url.origin, `${url.protocol}//*.${url.host}`];
}

function noStorage(): StudixError {
  return new StudixError("UNAVAILABLE", "No object storage is configured", {
    retryable: false,
    suggestedAction: "Add a storage profile under Settings > Storage & Media, or set S3_BUCKET.",
  });
}

export class ProfileStorageRouter implements StorageAdapter {
  private readonly built = new Map<string, Built>();
  private snapshot: StorageProfileSnapshot = { activeId: ENV_STORAGE_PROFILE_ID, profiles: [] };
  private loadedAt = Number.NEGATIVE_INFINITY;
  private loading: Promise<void> | undefined;
  private readonly locations = new Map<string, string>();
  /** A job attempt keeps the profile of its first write: its context object is the key. */
  private readonly pins = new WeakMap<TenantContext, string>();
  private readonly refreshMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ProfileStorageRouterOptions) {
    this.refreshMs = options.refreshMs ?? STORAGE_PROFILE_REFRESH_MS;
    this.now = options.now ?? Date.now;
  }

  /** Re-read the profiles now (after an operator change in this process). */
  async refresh(): Promise<void> {
    this.loadedAt = Number.NEGATIVE_INFINITY;
    await this.current();
  }

  private async current(): Promise<StorageProfileSnapshot> {
    if (this.now() - this.loadedAt < this.refreshMs) return this.snapshot;
    this.loading ??= this.options
      .load()
      .then((next) => {
        this.apply(next);
        this.loadedAt = this.now();
      })
      .catch((err: unknown) => {
        // Keep serving the last known profiles; try again on the next call after a short pause.
        this.loadedAt = this.now() - this.refreshMs + 2_000;
        this.options.logger?.warn("storage profiles could not be loaded; using the previous ones", {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.loading = undefined;
      });
    await this.loading;
    return this.snapshot;
  }

  private apply(next: StorageProfileSnapshot): void {
    const seen = new Set<string>();
    for (const target of next.profiles) {
      seen.add(target.id);
      const existing = this.built.get(target.id);
      if (existing?.revision === target.revision) continue;
      if (existing) this.retire(existing);
      this.built.set(target.id, {
        id: target.id,
        revision: target.revision,
        adapter: new S3StorageAdapter(target.options),
        origins: originsOf(target.options),
      });
    }
    for (const [id, existing] of this.built) {
      if (!seen.has(id)) {
        this.built.delete(id);
        this.retire(existing);
      }
    }
    if (next.activeId !== this.snapshot.activeId) {
      this.options.logger?.info("active storage profile changed", { profileId: next.activeId });
    }
    this.snapshot = next;
  }

  private retire(old: Built): void {
    setTimeout(() => old.adapter.destroy(), RETIRE_AFTER_MS).unref?.();
  }

  private adapterFor(id: string): S3StorageAdapter | undefined {
    if (id === ENV_STORAGE_PROFILE_ID) return this.options.fallback;
    return this.built.get(id)?.adapter;
  }

  /** Id of the profile new objects go to right now. */
  async activeProfileId(): Promise<string> {
    const snap = await this.current();
    return this.adapterFor(snap.activeId) ? snap.activeId : ENV_STORAGE_PROFILE_ID;
  }

  private async writeTarget(ctx: TenantContext): Promise<{ id: string; adapter: S3StorageAdapter }> {
    const pinned = this.pins.get(ctx);
    const pinnedAdapter = pinned === undefined ? undefined : this.adapterFor(pinned);
    if (pinned !== undefined && pinnedAdapter) return { id: pinned, adapter: pinnedAdapter };
    const id = await this.activeProfileId();
    const adapter = this.adapterFor(id);
    if (!adapter) throw noStorage();
    this.pins.set(ctx, id);
    return { id, adapter };
  }

  private remember(ctx: TenantContext, key: string, id: string): void {
    const k = `${ctx.organizationId}/${ctx.workspaceId}/${key}`;
    this.locations.delete(k);
    this.locations.set(k, id);
    if (this.locations.size > LOCATION_CACHE_LIMIT) {
      this.locations.delete(this.locations.keys().next().value as string);
    }
  }

  /** Profiles to try for a read, most likely first, without duplicates. */
  private async readOrder(ctx: TenantContext, key: string): Promise<{ order: string[]; known: boolean }> {
    const snap = await this.current();
    const cached = this.locations.get(`${ctx.organizationId}/${ctx.workspaceId}/${key}`);
    const first = cached ?? (await this.options.locate?.(ctx, key).catch(() => undefined));
    const all = [first, snap.activeId, ...snap.profiles.map((p) => p.id), ENV_STORAGE_PROFILE_ID];
    const order = [...new Set(all)].filter((id): id is string => id !== undefined && !!this.adapterFor(id));
    // Only a location this process confirmed is "known"; a recorded one is tried first but checked, since a
    // row written while app and worker disagreed for a few seconds about the active profile may be off.
    return { order, known: cached !== undefined && order[0] === cached };
  }

  /** Run `op` on the object's profile; on "not found" try the other readable profiles. */
  private async read<T>(
    ctx: TenantContext,
    key: string,
    op: (adapter: S3StorageAdapter) => Promise<T>,
    missing: (value: T) => boolean = () => false,
  ): Promise<T> {
    const { order } = await this.readOrder(ctx, key);
    if (order.length === 0) throw noStorage();
    let last: T | undefined;
    let notFound: unknown;
    for (const id of order) {
      try {
        const value = await op(this.adapterFor(id)!);
        if (missing(value)) {
          last = value;
          continue;
        }
        this.remember(ctx, key, id);
        return value;
      } catch (err) {
        if (err instanceof StudixError && err.code === "NOT_FOUND") {
          notFound = err;
          continue;
        }
        throw err;
      }
    }
    if (notFound && last === undefined) throw notFound;
    return last as T;
  }

  async put(
    ctx: TenantContext,
    key: string,
    body: StorageBody,
    options: PutObjectOptions,
  ): Promise<StoredObject> {
    const { id, adapter } = await this.writeTarget(ctx);
    const stored = await adapter.put(ctx, key, body, options);
    this.remember(ctx, key, id);
    return stored;
  }

  get(ctx: TenantContext, key: string) {
    return this.read(ctx, key, (a) => a.get(ctx, key));
  }

  download(ctx: TenantContext, key: string, filePath: string) {
    return this.read(ctx, key, (a) => a.download(ctx, key, filePath));
  }

  head(ctx: TenantContext, key: string) {
    return this.read(
      ctx,
      key,
      (a) => a.head(ctx, key),
      (v) => v === undefined,
    );
  }

  async signedUrl(ctx: TenantContext, key: string, options?: SignedUrlOptions): Promise<string> {
    const { order, known } = await this.readOrder(ctx, key);
    if (order.length === 0) throw noStorage();
    let id = order[0]!;
    if (!known && order.length > 1) {
      // Sign for the profile that actually holds the object (checked once per key, then cached).
      for (const candidate of order) {
        if (
          await this.adapterFor(candidate)!
            .head(ctx, key)
            .catch(() => undefined)
        ) {
          id = candidate;
          break;
        }
      }
    }
    this.remember(ctx, key, id);
    return this.adapterFor(id)!.signedUrl(ctx, key, options);
  }

  async signedUploadUrl(ctx: TenantContext, key: string, options: SignedUploadUrlOptions): Promise<string> {
    const { id, adapter } = await this.writeTarget(ctx);
    this.remember(ctx, key, id);
    return adapter.signedUploadUrl(ctx, key, options);
  }

  async delete(ctx: TenantContext, key: string): Promise<void> {
    const { order } = await this.readOrder(ctx, key);
    for (const id of order) await this.adapterFor(id)!.delete(ctx, key);
  }

  /** The startup and readiness write probe, against the active profile. */
  async probeWrite(): Promise<StorageProbeResult> {
    const adapter = this.adapterFor(await this.activeProfileId());
    if (!adapter) return { ok: false, step: "put", message: "No object storage is configured" };
    return adapter.probeWrite();
  }

  /** Origins media can be played from (every readable profile), for the dashboard CSP. */
  mediaOrigins(): string[] {
    const out = new Set(this.options.fallbackOrigins ?? []);
    for (const built of this.built.values()) for (const origin of built.origins) out.add(origin);
    return [...out];
  }

  destroy(): void {
    for (const built of this.built.values()) built.adapter.destroy();
    this.built.clear();
    this.options.fallback?.destroy();
  }
}

/** A stored profile as the profile service hands it out (settings plus the opened key pair). */
export interface StorageProfileEntry {
  id: string;
  revision: string;
  candidate: {
    endpoint?: string;
    bucket: string;
    region: string;
    forcePathStyle: boolean;
    keyPrefix: string;
    credentials: { accessKeyId: string; secretAccessKey: string };
  };
}

/**
 * Client settings for a dashboard-managed profile: its connections go through the guarded lookup, so an
 * endpoint that starts resolving to a private or metadata address is refused on connect.
 */
export function storageProfileOptions(
  candidate: StorageProfileEntry["candidate"],
  options: { policy: EndpointPolicy; signedUrlPolicy?: SignedUrlPolicy },
): S3StorageOptions {
  return {
    bucket: candidate.bucket,
    region: candidate.region,
    ...(candidate.endpoint ? { endpoint: candidate.endpoint } : {}),
    forcePathStyle: candidate.forcePathStyle,
    keyPrefix: candidate.keyPrefix,
    credentials: candidate.credentials,
    lookup: guardedLookup(options.policy),
    ...(options.signedUrlPolicy ? { signedUrlPolicy: options.signedUrlPolicy } : {}),
  };
}

/** Router snapshot from the profile service's snapshot. */
export function routerSnapshot(
  snapshot: { activeId: string; profiles: readonly StorageProfileEntry[] },
  options: { policy: EndpointPolicy; signedUrlPolicy?: SignedUrlPolicy },
): StorageProfileSnapshot {
  return {
    activeId: snapshot.activeId,
    profiles: snapshot.profiles.map((p) => ({
      id: p.id,
      revision: p.revision,
      options: storageProfileOptions(p.candidate, options),
    })),
  };
}

/**
 * The router app and worker use: the S3_* settings as the `env` profile (with the live key pair, when one is
 * stored) plus the stored profiles, re-read every STORAGE_PROFILE_REFRESH_MS.
 */
export function createProfileStorageRouterFromConfig(
  config: Parameters<typeof createS3StorageAdapterFromConfig>[0] &
    Pick<StudixConfig, "STUDIX_STORAGE_ALLOW_LOCAL_ENDPOINTS">,
  input: {
    credentials?: S3CredentialSource;
    profiles?: { snapshot(): Promise<{ activeId: string; profiles: readonly StorageProfileEntry[] }> };
    locate?: (ctx: TenantContext, key: string) => Promise<string | undefined>;
    logger?: Logger;
    refreshMs?: number;
  } = {},
): ProfileStorageRouter {
  const ttl = config.S3_SIGNED_URL_TTL_SECONDS;
  const signedUrlPolicy = { defaultTtlSeconds: ttl, maxTtlSeconds: ttl };
  const policy = { allowLocal: config.STUDIX_STORAGE_ALLOW_LOCAL_ENDPOINTS };
  const fallback = config.S3_BUCKET
    ? createS3StorageAdapterFromConfig(config, input.credentials ? { credentials: input.credentials } : {})
    : undefined;
  const envEndpoint = config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT;
  const profiles = input.profiles;
  return new ProfileStorageRouter({
    ...(fallback ? { fallback } : {}),
    fallbackOrigins:
      fallback && envEndpoint
        ? originsOf({
            bucket: "",
            region: "",
            endpoint: envEndpoint,
            forcePathStyle: config.S3_FORCE_PATH_STYLE,
          })
        : [],
    load: async () =>
      profiles
        ? routerSnapshot(await profiles.snapshot(), { policy, signedUrlPolicy })
        : { activeId: ENV_STORAGE_PROFILE_ID, profiles: [] },
    ...(input.locate ? { locate: input.locate } : {}),
    ...(input.logger ? { logger: input.logger } : {}),
    ...(input.refreshMs === undefined ? {} : { refreshMs: input.refreshMs }),
  });
}
