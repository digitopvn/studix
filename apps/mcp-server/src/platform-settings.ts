import type { PlatformCredentialService, PlatformCredentialView } from "@studix/auth";
import { assertPlatformOperator, type TenantContext } from "@studix/core";
import {
  MULTIX_ROLE_VENDORS,
  MULTIX_VENDOR_KEYS,
  MULTIX_VENDORS,
  type MultixDiagnosis,
  type MultixRole,
  type MultixVendor,
} from "@studix/providers";
import { type Clock, redact, systemClock } from "@studix/shared";
import type { StorageProbeResult } from "@studix/storage";

/*
 * What a platform operator sees and changes under Settings > Storage & Media. Object storage (R2) keeps
 * its source of truth in the deployment environment (S3_*): the dashboard shows redacted status and runs a
 * real put/get/head/delete check against the active configuration, but never holds the secret key. Media
 * vendor keys are stored sealed by the platform credential service and override the environment. Nothing
 * here returns a secret, and every call is limited to platform operators in a dashboard session.
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
  /** Where the values come from: R2 settings are managed in the deployment, not stored by Studix. */
  source: "environment";
  endpointHost?: string;
  bucket?: string;
  region: string;
  pathStyle: boolean;
  signedUrlTtlSeconds: number;
  /** First and last characters only. */
  accessKeyId?: string;
  secretAccessKey: SecretStatus;
  lastTest?: StorageTestView;
  /** True: a change is made in the deployment settings and needs a redeploy of the app and the worker. */
  changeNeedsRedeploy: true;
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
}

export interface PlatformSettingsView {
  storage: StorageStatusView;
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

export interface PlatformSettingsService {
  overview(ctx: TenantContext): Promise<PlatformSettingsView>;
  testStorage(ctx: TenantContext): Promise<StorageTestView>;
  testMedia(ctx: TenantContext): Promise<MediaTestView>;
  setMediaKey(ctx: TenantContext, name: string, value: string): Promise<PlatformCredentialView>;
  revokeMediaKey(ctx: TenantContext, name: string): Promise<PlatformCredentialView>;
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
  clock?: Clock;
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
    "The access key or secret was rejected. Create a new R2 API token, update S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY in the deployment settings, then redeploy the app and the worker.",
  missing_permission:
    "The token can reach the bucket but may not write it. Give it Object Read & Write on this bucket (not only Read), and check the bucket policy.",
  missing_bucket: "Check S3_BUCKET and S3_ENDPOINT: the bucket was not found at this endpoint.",
  remote_unavailable: "The storage endpoint did not answer. Check S3_ENDPOINT and the network, then retry.",
};

export function createPlatformSettingsService(deps: PlatformSettingsDeps): PlatformSettingsService {
  const clock = deps.clock ?? systemClock;
  const { config } = deps;
  let storageTest: StorageTestView | undefined;
  let mediaCheck: MediaStatusView["lastCheck"];
  let lastVendors: MultixDiagnosis["vendors"] | undefined;

  const secretStatus = (): SecretStatus => {
    if (!config.S3_SECRET_ACCESS_KEY || !config.S3_ACCESS_KEY_ID) return "missing";
    if (!storageTest) return "unverified";
    if (storageTest.ok) return "configured";
    return storageTest.diagnosis === "bad_credential" || storageTest.diagnosis === "missing_permission"
      ? "invalid"
      : "unverified";
  };

  const kindsOf = (vendor: MultixVendor): string[] =>
    (Object.keys(MULTIX_ROLE_VENDORS) as MultixRole[])
      .filter((role) => MULTIX_ROLE_VENDORS[role].includes(vendor))
      .map((role) => ROLE_LABELS[role]);

  return {
    async overview(ctx) {
      assertPlatformOperator(ctx);
      const stored = await deps.credentials.overview(ctx);
      const byName = new Map(stored.credentials.map((c) => [c.name, c]));
      return {
        storage: {
          configured: Boolean(config.S3_BUCKET),
          source: "environment",
          ...(endpointHost(config.S3_ENDPOINT) ? { endpointHost: endpointHost(config.S3_ENDPOINT) } : {}),
          ...(config.S3_BUCKET ? { bucket: config.S3_BUCKET } : {}),
          region: config.S3_REGION,
          pathStyle: config.S3_FORCE_PATH_STYLE,
          signedUrlTtlSeconds: config.S3_SIGNED_URL_TTL_SECONDS,
          ...(maskAccessKeyId(config.S3_ACCESS_KEY_ID)
            ? { accessKeyId: maskAccessKeyId(config.S3_ACCESS_KEY_ID) }
            : {}),
          secretAccessKey: secretStatus(),
          ...(storageTest ? { lastTest: storageTest } : {}),
          changeNeedsRedeploy: true,
        },
        media: {
          executable: config.MULTIX_BIN ? "configured" : "missing",
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
            ? "This check runs in the app process. The worker runs the jobs: confirm it reports the same media status on its /readyz."
            : "MULTIX_BIN is not set in the app process. Check the worker separately: it runs the jobs.",
        },
      };
    },

    async testStorage(ctx) {
      assertPlatformOperator(ctx);
      const at = clock.now();
      let view: StorageTestView;
      if (!config.S3_BUCKET || !deps.storage) {
        view = {
          ok: false,
          at,
          diagnosis: "missing_credential",
          message: "No bucket is configured on this server.",
          suggestedAction: DIAGNOSIS_ACTION.missing_credential,
        };
      } else {
        const probe = await deps.storage.probeWrite();
        const diagnosis = storageDiagnosis(probe);
        view = {
          ok: probe.ok,
          at,
          diagnosis,
          ...(probe.step ? { failedStep: probe.step } : {}),
          ...(probe.status === undefined ? {} : { httpStatus: probe.status }),
          ...(probe.s3Code ? { s3Code: probe.s3Code } : {}),
          ...(probe.message ? { message: redact(probe.message).slice(0, 300) } : {}),
          ...(diagnosis === "ok" ? {} : { suggestedAction: DIAGNOSIS_ACTION[diagnosis] }),
        };
      }
      storageTest = view;
      return view;
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
        ...(diagnosis.reason ? { reason: diagnosis.reason } : {}),
        ...(diagnosis.code ? { code: diagnosis.code } : {}),
      };
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
