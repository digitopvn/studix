import {
  type PlatformCredentialService,
  type PlatformCredentialView,
  STORAGE_KEY_NAMES,
  type StorageKeyPair,
  type StorageProfileCandidate,
  type StorageProfileFields,
  type StorageProfileService,
  type StorageProfileView,
  type VendorKeyTester,
} from "@studix/auth";
import { assertPlatformOperator, type TenantContext } from "@studix/core";
import {
  MULTIX_ROLE_VENDORS,
  MULTIX_VENDOR_KEYS,
  MULTIX_VENDORS,
  type MultixDiagnosis,
  type MultixRole,
  type MultixVendor,
} from "@studix/providers";
import { type Clock, redact, StudixError, systemClock } from "@studix/shared";
import type { S3Credentials, StorageProbeResult } from "@studix/storage";

/*
 * What a platform operator sees and changes under Settings > Storage & Media. Object storage is a set of
 * storage profiles (provider, endpoint, bucket, region, path style, key prefix and a sealed key pair); the
 * S3_* deployment settings are the `env` profile, active while no stored profile is. The `env` key pair may
 * also be stored from the dashboard, sealed like the media vendor keys. Anything new is saved only after a
 * real put/get/head/delete with it passes. Switching the active profile changes where new objects go; old
 * objects are read from the profile their rows record. Nothing here returns a secret, and every call is
 * limited to platform operators in a dashboard session.
 */

/** Which kinds of media each vendor key serves, from the routes the worker actually uses. */
const ROLE_LABELS: Readonly<Record<MultixRole, string>> = {
  image: "image",
  video: "video",
  lipsync: "lip-sync",
  videoUpscale: "video upscale",
  imageUpscale: "image upscale",
  voice: "voice",
  music: "music",
  sfx: "SFX",
};

export type StorageDiagnosis =
  | "ok"
  | "missing_credential"
  | "bad_credential"
  | "missing_permission"
  | "missing_bucket"
  | "remote_unavailable";

export interface StorageTestView {
  ok: boolean;
  at: Date;
  /** `put`, `get`, `head` or `delete`, when it failed. */
  failedStep?: string;
  httpStatus?: number;
  s3Code?: string;
  diagnosis: StorageDiagnosis;
  message?: string;
  suggestedAction?: string;
}

export type SecretStatus = "configured" | "missing" | "invalid" | "unverified";

export interface StorageStatusView {
  configured: boolean;
  /** Where the key pair comes from: stored here (overrides the environment) or the deployment settings. */
  source: "dashboard" | "environment";
  /** `unavailable` without STUDIX_SECRETS_KEY or a bucket: the key pair can then only come from the environment. */
  credentialStorage: "available" | "unavailable";
  /** The stored secret key's metadata (hint, version, who changed it); absent while the environment is used. */
  credential?: PlatformCredentialView;
  endpointHost?: string;
  bucket?: string;
  region: string;
  pathStyle: boolean;
  signedUrlTtlSeconds: number;
  /** First and last characters only. */
  accessKeyId?: string;
  secretAccessKey: SecretStatus;
  lastTest?: StorageTestView;
  /** True while the key pair comes from the deployment settings, where a change needs a redeploy. */
  changeNeedsRedeploy: boolean;
}

export interface MediaVendorView {
  vendor: MultixVendor;
  /** The variable name the CLI reads; a name, never a value. */
  keyName: string;
  kinds: string[];
  credential: PlatformCredentialView;
  /** From the last `multix check` in this process; `undefined` until a check ran. */
  status: "configured" | "missing" | "unverified";
}

export interface MediaStatusView {
  executable: "configured" | "missing";
  /** Path set by MULTIX_BIN; a path is not a credential. */
  path?: string;
  homeEnvDisabled: boolean;
  credentialStorage: "available" | "unavailable";
  vendors: MediaVendorView[];
  lastCheck?: { at: Date; state: MultixDiagnosis["state"]; reason?: string; code?: string };
  /** What applying a key change costs: it does not restart anything. */
  apply: { keyChange: string; executableChange: string };
  /** The worker runs the jobs; this check ran in the app process. */
  process: "app";
  processNote: string;
  /** The worker's own report from its `/readyz`; absent when STUDIX_WORKER_HEALTH_URL is not set. */
  worker?: WorkerMediaView;
}

/** The `media` block of the worker's `/readyz`: presence only, never a key value or a path. */
export interface WorkerMediaReport {
  executable: "configured" | "missing";
  state: MultixDiagnosis["state"];
  code?: string;
  /** The worker has STUDIX_SECRETS_KEY and can open dashboard-stored keys. */
  secretsKey: boolean;
  vendors: Partial<Record<MultixVendor, boolean>>;
}

export interface WorkerMediaView {
  reachable: boolean;
  /** Undefined while the worker is unreachable or has not run its first check. */
  report?: WorkerMediaReport;
  /** Where the app and the worker disagree, in the operator's words. Empty when they agree or nothing is known. */
  mismatches: string[];
}

export interface PlatformSettingsView {
  storage: StorageStatusView;
  /** The `env` profile first, then stored ones; absent when profiles cannot be stored (no STUDIX_SECRETS_KEY). */
  storageProfiles?: StorageProfileView[];
  media: MediaStatusView;
}

export interface MediaTestView {
  ok: boolean;
  at: Date;
  state: MultixDiagnosis["state"];
  /** `missing credential` etc.; the operator's wording for a failed check. */
  diagnosis: "ok" | "missing_executable" | "missing_credential" | "check_failed";
  vendors: Array<{ vendor: MultixVendor; keyName: string; hasKey: boolean }>;
  reason?: string;
  code?: string;
  /** The check reads which keys exist; it calls no paid API. */
  paidCalls: false;
}

export interface MediaKeyTestView {
  name: string;
  at: Date;
  /** `unverified` when the vendor offers no free check or did not answer; no paid call is made. */
  verdict: "available" | "invalid" | "unverified";
  httpStatus?: number;
  note?: string;
}

export interface PlatformSettingsService {
  overview(ctx: TenantContext): Promise<PlatformSettingsView>;
  testStorage(ctx: TenantContext): Promise<StorageTestView>;
  testMedia(ctx: TenantContext): Promise<MediaTestView>;
  setMediaKey(ctx: TenantContext, name: string, value: string): Promise<PlatformCredentialView>;
  revokeMediaKey(ctx: TenantContext, name: string): Promise<PlatformCredentialView>;
  /** A free, read-only account lookup at the vendor with the key in use (stored or from the environment). */
  testMediaKey(ctx: TenantContext, name: string): Promise<MediaKeyTestView>;
  /** Probe the pair against the bucket, then store it; nothing is saved when the probe fails. */
  setStorageKey(ctx: TenantContext, pair: S3Credentials): Promise<StorageTestView>;
  /** Remove the stored pair; S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY from the environment apply again. */
  revokeStorageKey(ctx: TenantContext): Promise<void>;
  listStorageProfiles(ctx: TenantContext): Promise<StorageProfileView[]>;
  /** Probe the candidate profile, then store it (inactive); nothing is saved when the probe fails. */
  createStorageProfile(
    ctx: TenantContext,
    fields: StorageProfileFields,
    key: StorageKeyPair,
  ): Promise<StorageProfileView>;
  /** Without `key` the stored pair is kept; the probe runs with the new settings either way. */
  updateStorageProfile(
    ctx: TenantContext,
    id: string,
    fields: StorageProfileFields,
    key?: StorageKeyPair,
  ): Promise<StorageProfileView>;
  /** New objects go to this profile (or `env`) from now on, on the app and, within seconds, on the worker. */
  activateStorageProfile(ctx: TenantContext, id: string): Promise<StorageProfileView>;
  testStorageProfile(ctx: TenantContext, id: string): Promise<StorageTestView>;
  /** Refused while the profile is active or assets are stored in it. */
  deleteStorageProfile(ctx: TenantContext, id: string): Promise<void>;
}

export interface PlatformSettingsDeps {
  config: {
    S3_ENDPOINT?: string | undefined;
    S3_BUCKET?: string | undefined;
    S3_REGION: string;
    S3_ACCESS_KEY_ID?: string | undefined;
    S3_SECRET_ACCESS_KEY?: string | undefined;
    S3_FORCE_PATH_STYLE: boolean;
    S3_SIGNED_URL_TTL_SECONDS: number;
    MULTIX_BIN?: string | undefined;
    MULTIX_ALLOW_HOME_ENV: boolean;
  };
  /** Absent when no bucket is configured. */
  storage?: { probeWrite(): Promise<StorageProbeResult> };
  /** Absent when MULTIX_BIN is not set in this process. */
  multix?: { diagnose(signal?: AbortSignal): Promise<MultixDiagnosis> };
  credentials: PlatformCredentialService;
  /** Stores the storage key pair (STORAGE_KEY_NAMES); absent when no bucket is configured. */
  storageCredentials?: PlatformCredentialService;
  /** Put/get/head/delete with a candidate pair before it is stored. */
  probeCandidate?: (pair: S3Credentials) => Promise<StorageProbeResult>;
  /** Stored storage profiles; absent without STUDIX_SECRETS_KEY. */
  profiles?: StorageProfileService;
  /** Put/get/head/delete with a candidate profile (through the SSRF-guarded connection) before it is stored. */
  probeProfile?: (candidate: StorageProfileCandidate) => Promise<StorageProbeResult>;
  /** Called after a profile change so this process applies it at once instead of within the refresh period. */
  profilesChanged?: () => Promise<void>;
  vendorTester?: VendorKeyTester;
  /** The process environment, for testing a vendor key that is not stored here. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Reads the worker's media report (STUDIX_WORKER_HEALTH_URL); rejects when the worker cannot be reached. */
  worker?: { media(): Promise<WorkerMediaReport | undefined> };
  clock?: Clock;
}

/** Fetch `<base>/readyz` of a worker and keep its `media` block when it has the expected shape. */
export async function fetchWorkerMedia(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3_000,
): Promise<WorkerMediaReport | undefined> {
  const res = await fetchImpl(new URL("/readyz", baseUrl), { signal: AbortSignal.timeout(timeoutMs) });
  // A starting or stopping worker answers 503 with a body; only an unreadable answer means unreachable.
  const body = (await res.json()) as { media?: unknown };
  const media = body.media as Partial<WorkerMediaReport> | undefined;
  if (!media || typeof media !== "object") return undefined;
  if (media.executable !== "configured" && media.executable !== "missing") return undefined;
  if (typeof media.secretsKey !== "boolean" || typeof media.vendors !== "object" || !media.vendors) {
    return undefined;
  }
  const vendors: WorkerMediaReport["vendors"] = {};
  for (const vendor of MULTIX_VENDORS) {
    const has = (media.vendors as Record<string, unknown>)[vendor];
    if (typeof has === "boolean") vendors[vendor] = has;
  }
  return {
    executable: media.executable,
    state: media.state === "ready" || media.state === "missing_executable" ? media.state : "check_failed",
    ...(typeof media.code === "string" ? { code: media.code.slice(0, 40) } : {}),
    secretsKey: media.secretsKey,
    vendors,
  };
}

/** Differences between the app's view of media and the worker's report. */
export function mediaMismatches(
  app: {
    executable: MediaStatusView["executable"];
    credentialStorage: MediaStatusView["credentialStorage"];
    /** From the app's last ready `multix check`; without one, keys are not compared. */
    vendors?: MultixDiagnosis["vendors"];
  },
  worker: WorkerMediaReport,
): string[] {
  const out: string[] = [];
  if (app.executable !== worker.executable) {
    out.push(
      worker.executable === "missing"
        ? "MULTIX_BIN is set on the app but not on the worker."
        : "MULTIX_BIN is set on the worker but not on the app.",
    );
  }
  if (app.credentialStorage === "available" && !worker.secretsKey) {
    out.push("STUDIX_SECRETS_KEY is missing on the worker, so it ignores keys set here.");
  } else if (app.credentialStorage === "unavailable" && worker.secretsKey) {
    out.push("STUDIX_SECRETS_KEY is set on the worker but not on the app.");
  }
  if (app.vendors && worker.state === "ready") {
    for (const vendor of MULTIX_VENDORS) {
      const onWorker = worker.vendors[vendor];
      if (onWorker === undefined || onWorker === app.vendors[vendor]) continue;
      out.push(
        onWorker
          ? `${MULTIX_VENDOR_KEYS[vendor]} is found on the worker but not on the app.`
          : `${MULTIX_VENDOR_KEYS[vendor]} is found on the app but not on the worker.`,
      );
    }
  }
  return out;
}

function maskAccessKeyId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return id.length <= 8 ? "…" : `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function endpointHost(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  try {
    return new URL(endpoint).host;
  } catch {
    return undefined;
  }
}

const BAD_CREDENTIAL_CODES = new Set([
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "InvalidToken",
  "ExpiredToken",
  "AuthFailure",
]);

/** The operator's wording for a failed storage probe. */
export function storageDiagnosis(probe: StorageProbeResult): StorageDiagnosis {
  if (probe.ok) return "ok";
  if (probe.s3Code && BAD_CREDENTIAL_CODES.has(probe.s3Code)) return "bad_credential";
  if (probe.status === 401) return "bad_credential";
  if (probe.status === 403) return "missing_permission";
  if (probe.status === 404 || probe.s3Code === "NoSuchBucket") return "missing_bucket";
  return "remote_unavailable";
}

const DIAGNOSIS_ACTION: Record<Exclude<StorageDiagnosis, "ok">, string> = {
  missing_credential:
    "Set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY in the deployment settings, then redeploy.",
  bad_credential:
    "The access key or secret was rejected. Create a new R2 API token and store it with Set key on this page (or update S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY in the deployment settings and redeploy).",
  missing_permission:
    "The token can reach the bucket but may not write it. Give it Object Read & Write on this bucket (not only Read), and check the bucket policy.",
  missing_bucket: "Check S3_BUCKET and S3_ENDPOINT: the bucket was not found at this endpoint.",
  remote_unavailable: "The storage endpoint did not answer. Check S3_ENDPOINT and the network, then retry.",
};

function storageView(probe: StorageProbeResult, at: Date): StorageTestView {
  const diagnosis = storageDiagnosis(probe);
  return {
    ok: probe.ok,
    at,
    diagnosis,
    ...(probe.step ? { failedStep: probe.step } : {}),
    ...(probe.status === undefined ? {} : { httpStatus: probe.status }),
    ...(probe.s3Code ? { s3Code: probe.s3Code } : {}),
    ...(probe.message ? { message: redact(probe.message).slice(0, 300) } : {}),
    ...(diagnosis === "ok"
      ? {}
      : {
          suggestedAction:
            probe.s3Code === "BodyMismatch"
              ? "The endpoint answered, but with different content than was written. Check that S3_ENDPOINT is the bucket's S3 API and that no proxy rewrites responses."
              : DIAGNOSIS_ACTION[diagnosis],
        }),
  };
}

/** Refuse a candidate whose probe failed, with the diagnosis and no secret. */
function assertProbePassed(view: StorageTestView, what: string): void {
  if (view.ok) return;
  throw new StudixError("VALIDATION", `${what} failed the storage check; nothing was saved`, {
    retryable: false,
    details: {
      diagnosis: view.diagnosis,
      ...(view.failedStep ? { failedStep: view.failedStep } : {}),
      ...(view.httpStatus === undefined ? {} : { httpStatus: view.httpStatus }),
      ...(view.s3Code ? { s3Code: view.s3Code } : {}),
      ...(view.message ? { message: view.message } : {}),
    },
    ...(view.suggestedAction ? { suggestedAction: view.suggestedAction } : {}),
  });
}

export function createPlatformSettingsService(deps: PlatformSettingsDeps): PlatformSettingsService {
  const clock = deps.clock ?? systemClock;
  const { config } = deps;
  let storageTest: StorageTestView | undefined;
  let mediaCheck: MediaStatusView["lastCheck"];
  let lastVendors: MultixDiagnosis["vendors"] | undefined;

  /** The pair stored here, when both halves are; it wins over the environment. */
  const storedPair = async (): Promise<S3Credentials | undefined> => {
    if (!deps.storageCredentials) return undefined;
    const { values } = await deps.storageCredentials.loadValues();
    const [id, secret] = STORAGE_KEY_NAMES.map((name) => values[name]);
    return id && secret ? { accessKeyId: id, secretAccessKey: secret } : undefined;
  };

  const secretStatus = (stored: boolean): SecretStatus => {
    if (!stored && (!config.S3_SECRET_ACCESS_KEY || !config.S3_ACCESS_KEY_ID)) return "missing";
    if (!storageTest) return "unverified";
    if (storageTest.ok) return "configured";
    return storageTest.diagnosis === "bad_credential" || storageTest.diagnosis === "missing_permission"
      ? "invalid"
      : "unverified";
  };

  /** Keep the outcome of the check next to each dashboard-stored key (a key from the environment has no row). */
  const recordVendorTests = async (ctx: TenantContext, diagnosis: MultixDiagnosis): Promise<void> => {
    for (const vendor of MULTIX_VENDORS) {
      const ok = diagnosis.state === "ready" && diagnosis.vendors[vendor];
      await deps.credentials
        .recordTest(ctx, MULTIX_VENDOR_KEYS[vendor], {
          ok,
          detail: ok ? "Key found by multix check" : (diagnosis.reason ?? "Key not found by multix check"),
        })
        .catch(() => {});
    }
  };

  const profilesOrThrow = (ctx: TenantContext): StorageProfileService => {
    assertPlatformOperator(ctx);
    if (!deps.profiles) {
      throw new StudixError("UNAVAILABLE", "Storage profiles cannot be stored on this server", {
        retryable: false,
        suggestedAction: "Set STUDIX_SECRETS_KEY (32 random bytes, base64) on the app and the worker.",
      });
    }
    return deps.profiles;
  };

  const probeProfileOrThrow = () => {
    if (!deps.probeProfile) {
      throw new StudixError("UNAVAILABLE", "Storage profiles cannot be checked on this server", {
        retryable: false,
      });
    }
    return deps.probeProfile;
  };

  const verifyProfile = async (candidate: StorageProfileCandidate): Promise<void> => {
    assertProbePassed(
      storageView(await probeProfileOrThrow()(candidate), clock.now()),
      "The storage profile",
    );
  };

  const kindsOf = (vendor: MultixVendor): string[] =>
    (Object.keys(MULTIX_ROLE_VENDORS) as MultixRole[])
      .filter((role) => MULTIX_ROLE_VENDORS[role].includes(vendor))
      .map((role) => ROLE_LABELS[role]);

  return {
    async overview(ctx) {
      assertPlatformOperator(ctx);
      const stored = await deps.credentials.overview(ctx);
      const pair = await storedPair();
      const storageStored = deps.storageCredentials ? await deps.storageCredentials.overview(ctx) : undefined;
      const storageCredential = storageStored?.credentials.find((c) => c.name === "S3_SECRET_ACCESS_KEY");
      const accessKeyId = maskAccessKeyId(pair?.accessKeyId ?? config.S3_ACCESS_KEY_ID);
      const byName = new Map(stored.credentials.map((c) => [c.name, c]));
      const executable: MediaStatusView["executable"] = config.MULTIX_BIN ? "configured" : "missing";
      let worker: WorkerMediaView | undefined;
      if (deps.worker) {
        try {
          const report = await deps.worker.media();
          const app = {
            executable,
            credentialStorage: stored.storage,
            ...(lastVendors ? { vendors: lastVendors } : {}),
          };
          worker = {
            reachable: true,
            ...(report ? { report } : {}),
            mismatches: report ? mediaMismatches(app, report) : [],
          };
        } catch {
          worker = { reachable: false, mismatches: [] };
        }
      }
      const storageProfiles = deps.profiles ? await deps.profiles.list(ctx) : undefined;
      return {
        ...(storageProfiles ? { storageProfiles } : {}),
        storage: {
          configured: Boolean(config.S3_BUCKET) || Boolean(storageProfiles?.some((p) => p.id !== "env")),
          source: pair ? "dashboard" : "environment",
          credentialStorage: storageStored?.storage ?? "unavailable",
          ...(pair && storageCredential ? { credential: storageCredential } : {}),
          ...(endpointHost(config.S3_ENDPOINT) ? { endpointHost: endpointHost(config.S3_ENDPOINT) } : {}),
          ...(config.S3_BUCKET ? { bucket: config.S3_BUCKET } : {}),
          region: config.S3_REGION,
          pathStyle: config.S3_FORCE_PATH_STYLE,
          signedUrlTtlSeconds: config.S3_SIGNED_URL_TTL_SECONDS,
          ...(accessKeyId ? { accessKeyId } : {}),
          secretAccessKey: secretStatus(Boolean(pair)),
          ...(storageTest ? { lastTest: storageTest } : {}),
          changeNeedsRedeploy: !pair,
        },
        media: {
          executable,
          ...(config.MULTIX_BIN ? { path: config.MULTIX_BIN } : {}),
          homeEnvDisabled: !config.MULTIX_ALLOW_HOME_ENV,
          credentialStorage: stored.storage,
          vendors: MULTIX_VENDORS.map((vendor) => {
            const keyName = MULTIX_VENDOR_KEYS[vendor];
            const credential = byName.get(keyName) ?? { name: keyName, source: "missing" as const };
            return {
              vendor,
              keyName,
              kinds: kindsOf(vendor),
              credential,
              status: lastVendors ? (lastVendors[vendor] ? "configured" : "missing") : "unverified",
            };
          }),
          ...(mediaCheck ? { lastCheck: mediaCheck } : {}),
          apply: {
            keyChange:
              "Applies to the next media call on the app and the worker (within seconds). Calls already running keep the key they started with, and nothing is restarted.",
            executableChange: "MULTIX_BIN is set in the deployment settings and needs a redeploy.",
          },
          process: "app",
          processNote: config.MULTIX_BIN
            ? "This check runs in the app process. The worker runs the jobs and needs the same STUDIX_SECRETS_KEY to read keys set here; the first media job confirms it."
            : "MULTIX_BIN is not set in the app process. Check the worker separately: it runs the jobs.",
          ...(worker ? { worker } : {}),
        },
      };
    },

    async testStorage(ctx) {
      assertPlatformOperator(ctx);
      const at = clock.now();
      let view: StorageTestView;
      const anyProfile = Boolean((await deps.profiles?.list(ctx))?.some((p) => p.active && p.id !== "env"));
      if ((!config.S3_BUCKET && !anyProfile) || !deps.storage) {
        view = {
          ok: false,
          at,
          diagnosis: "missing_credential",
          message: "No bucket is configured on this server.",
          suggestedAction: DIAGNOSIS_ACTION.missing_credential,
        };
      } else {
        view = storageView(await deps.storage.probeWrite(), at);
      }
      storageTest = view;
      return view;
    },

    async setStorageKey(ctx, pair) {
      assertPlatformOperator(ctx);
      const store = deps.storageCredentials;
      if (!config.S3_BUCKET || !store || !deps.probeCandidate) {
        throw new StudixError("UNAVAILABLE", "No bucket is configured on this server", {
          retryable: false,
          suggestedAction: "Set S3_BUCKET (and S3_ENDPOINT for R2) in the deployment settings first.",
        });
      }
      const candidate = {
        accessKeyId: pair.accessKeyId.trim(),
        secretAccessKey: pair.secretAccessKey.trim(),
      };
      const view = storageView(await deps.probeCandidate(candidate), clock.now());
      assertProbePassed(view, "The new key pair");
      await store.set(ctx, "S3_ACCESS_KEY_ID", candidate.accessKeyId);
      await store.set(ctx, "S3_SECRET_ACCESS_KEY", candidate.secretAccessKey);
      await store.recordTest(ctx, "S3_SECRET_ACCESS_KEY", {
        ok: true,
        detail: "Write, read and delete passed",
      });
      storageTest = view;
      return view;
    },

    async revokeStorageKey(ctx) {
      assertPlatformOperator(ctx);
      const store = deps.storageCredentials;
      if (!store || !(await storedPair())) {
        throw new StudixError("NOT_FOUND", "No storage key is stored here", {
          retryable: false,
          suggestedAction: "A key from the environment is changed in the deployment settings.",
        });
      }
      for (const name of STORAGE_KEY_NAMES) {
        await store.revoke(ctx, name).catch((err: unknown) => {
          if (!(err instanceof StudixError && err.code === "NOT_FOUND")) throw err;
        });
      }
      storageTest = undefined;
    },

    async listStorageProfiles(ctx) {
      return profilesOrThrow(ctx).list(ctx);
    },

    async createStorageProfile(ctx, fields, key) {
      const view = await profilesOrThrow(ctx).create(ctx, fields, key, verifyProfile);
      await deps.profilesChanged?.();
      return view;
    },

    async updateStorageProfile(ctx, id, fields, key) {
      const view = await profilesOrThrow(ctx).update(ctx, id, fields, key, verifyProfile);
      await deps.profilesChanged?.();
      return view;
    },

    async activateStorageProfile(ctx, id) {
      const view = await profilesOrThrow(ctx).activate(ctx, id);
      storageTest = undefined;
      await deps.profilesChanged?.();
      return view;
    },

    async testStorageProfile(ctx, id) {
      const profiles = profilesOrThrow(ctx);
      if (id === "env") return this.testStorage(ctx);
      const candidate = await profiles.candidate(ctx, id);
      const view = storageView(await probeProfileOrThrow()(candidate), clock.now());
      await profiles.recordTest(ctx, id, {
        ok: view.ok,
        detail: view.ok
          ? "Write, read and delete passed"
          : `${view.diagnosis}${view.failedStep ? ` at ${view.failedStep}` : ""}`,
      });
      return view;
    },

    async deleteStorageProfile(ctx, id) {
      await profilesOrThrow(ctx).revoke(ctx, id);
      await deps.profilesChanged?.();
    },

    async testMediaKey(ctx, name) {
      assertPlatformOperator(ctx);
      if (!deps.credentials.isManaged(name)) {
        throw new StudixError("VALIDATION", "Unknown credential name", { retryable: false });
      }
      const value = (await deps.credentials.loadValues()).values[name] ?? deps.env?.[name];
      if (!value) {
        throw new StudixError("NOT_FOUND", `${name} is not set here or in the environment`, {
          retryable: false,
        });
      }
      const verdict = (await deps.vendorTester?.(name, value)) ?? {
        verdict: "unverified" as const,
        note: "This vendor offers no free key check; the first media job that uses it confirms the key.",
      };
      const at = clock.now();
      const note =
        verdict.note ?? (verdict.verdict === "available" ? "The vendor accepted the key" : undefined);
      await deps.credentials
        .recordTest(ctx, name, { ok: verdict.verdict === "available", ...(note ? { detail: note } : {}) })
        .catch(() => {});
      return {
        name,
        at,
        verdict: verdict.verdict,
        ...(verdict.httpStatus === undefined ? {} : { httpStatus: verdict.httpStatus }),
        ...(note ? { note } : {}),
      };
    },

    async testMedia(ctx) {
      assertPlatformOperator(ctx);
      const at = clock.now();
      const diagnosis: MultixDiagnosis = deps.multix
        ? await deps.multix.diagnose()
        : {
            state: "missing_executable",
            vendors: Object.fromEntries(MULTIX_VENDORS.map((v) => [v, false])) as MultixDiagnosis["vendors"],
            reason: "MULTIX_BIN is not set in the app process",
            code: "NOT_SET",
          };
      const vendors = MULTIX_VENDORS.map((vendor) => ({
        vendor,
        keyName: MULTIX_VENDOR_KEYS[vendor],
        hasKey: diagnosis.vendors[vendor],
      }));
      const anyKey = vendors.some((v) => v.hasKey);
      lastVendors = diagnosis.state === "ready" ? diagnosis.vendors : undefined;
      mediaCheck = {
        at,
        state: diagnosis.state,
        ...(diagnosis.reason ? { reason: redact(diagnosis.reason).slice(0, 300) } : {}),
        ...(diagnosis.code ? { code: diagnosis.code } : {}),
      };
      await recordVendorTests(ctx, diagnosis);
      return {
        ok: diagnosis.state === "ready" && anyKey,
        at,
        state: diagnosis.state,
        diagnosis:
          diagnosis.state === "ready"
            ? anyKey
              ? "ok"
              : "missing_credential"
            : diagnosis.state === "missing_executable"
              ? "missing_executable"
              : "check_failed",
        vendors,
        ...(diagnosis.reason ? { reason: redact(diagnosis.reason).slice(0, 300) } : {}),
        ...(diagnosis.code ? { code: diagnosis.code } : {}),
        paidCalls: false,
      };
    },

    async setMediaKey(ctx, name, value) {
      const view = await deps.credentials.set(ctx, name, value);
      lastVendors = undefined;
      return view;
    },

    async revokeMediaKey(ctx, name) {
      const view = await deps.credentials.revoke(ctx, name);
      lastVendors = undefined;
      return view;
    },
  };
}
