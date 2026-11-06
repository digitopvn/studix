import type { PlatformCredentialService, PlatformCredentialView } from "@studix/auth";
import type { MultixProvider, MultixVendor } from "@studix/providers";
import { MULTIX_VENDOR_KEYS, MULTIX_VENDORS, multixVendorRoles } from "@studix/providers";
import { type StudixConfig, StudixError } from "@studix/shared";
import type { StorageProbeResult } from "@studix/storage";

/** What the dashboard may say about R2/S3 object storage. Secrets are reduced to a mask or a boolean. */
export interface StorageSettingsView {
  /** R2 settings come from the deployment environment (TOSE); the dashboard shows and tests them. */
  source: "env";
  configured: boolean;
  endpointHost?: string;
  bucket?: string;
  region: string;
  forcePathStyle: boolean;
  accessKeyId?: string;
  secretAccessKey: "configured" | "missing";
}

export type DiagnosticClass =
  | "ok"
  | "missing_credential"
  | "bad_credential"
  | "missing_executable"
  | "missing_permission"
  | "remote_unavailable";

export interface StorageTestResult {
  ok: boolean;
  at: string;
  diagnostic: DiagnosticClass;
  /** Failing step (`put`, `head`, `delete`), HTTP status and S3 error code; never credentials. */
  step?: string;
  status?: number;
  s3Code?: string;
  message: string;
}

export interface VendorView extends PlatformCredentialView {
  vendor: MultixVendor;
  /** Media roles that stop working while this vendor has no key. */
  kinds: string[];
}

export interface MultixCheckResult {
  ok: boolean;
  at: string;
  diagnostic: DiagnosticClass;
  message: string;
  /** Whether `multix check` found each vendor's key in the environment the CLI would run with. */
  keyFound: Record<string, boolean>;
}

export interface PlatformMediaOverview {
  storage: StorageSettingsView & { lastTest?: StorageTestResult };
  multix: {
    enabled: boolean;
    /** MULTIX_BIN (a path, not a secret). */
    bin?: string;
    reason?: string;
    models: Record<string, string>;
    lastCheck?: MultixCheckResult;
  };
  vendors: VendorView[];
  /** What an operator needs to know about applying a change. */
  apply: { mediaKeys: string; storage: string };
}

export interface PlatformAdmin {
  /** Platform operators are the listed emails, and only when the sign-in provider verified the address. */
  isOperator(user: { email: string; emailVerified: boolean }): boolean;
  overview(): Promise<PlatformMediaOverview>;
  saveVendorKey(
    ctx: Parameters<PlatformCredentialService["save"]>[0],
    vendor: string,
    input: unknown,
  ): Promise<VendorView>;
  revokeVendorKey(
    ctx: Parameters<PlatformCredentialService["revoke"]>[0],
    vendor: string,
  ): Promise<VendorView>;
  testStorage(): Promise<StorageTestResult>;
  /** `multix check` only: free, never submits a paid request. */
  checkMultix(vendor?: string): Promise<MultixCheckResult>;
}

export interface PlatformAdminDeps {
  operatorEmails: readonly string[];
  credentials: PlatformCredentialService;
  /** Reload stored credentials into this process right after a change. */
  refreshCredentials(): Promise<void>;
  storage?: { probeWrite(): Promise<StorageProbeResult> };
  storageSettings: StorageSettingsView;
  multix?: Pick<MultixProvider, "status" | "readiness" | "checkRan" | "invalidateCapabilities">;
  /** MULTIX_BIN as configured (a path, not a secret). */
  multixBin?: string;
  clock?: { now(): Date };
}

const APPLY = {
  mediaKeys:
    "Saved keys reach the app and the worker within about 15 seconds, without a redeploy. A job that is already running keeps the key it started with; later jobs use the new one.",
  storage:
    "Object storage settings come from the deployment environment (S3_*). Change them in TOSE and redeploy the app and the worker together; this page only tests them.",
};

/** Map a failed probe to the operator-facing class; status and code are kept for the details. */
export function classifyStorageProbe(probe: StorageProbeResult): DiagnosticClass {
  if (probe.ok) return "ok";
  if (
    probe.status === 401 ||
    /InvalidAccessKeyId|SignatureDoesNotMatch|AuthorizationHeaderMalformed/.test(probe.s3Code ?? "")
  )
    return "bad_credential";
  if (probe.status === 403) return "missing_permission";
  return "remote_unavailable";
}

const STORAGE_HINTS: Record<DiagnosticClass, string> = {
  ok: "Wrote, read back and deleted a temporary object under the tenant prefix.",
  missing_credential: "S3_ACCESS_KEY_ID or S3_SECRET_ACCESS_KEY is not set in the deployment environment.",
  bad_credential:
    "The store does not recognise the access key or its signature: check the key pair, rotation and S3_ENDPOINT.",
  missing_executable: "",
  missing_permission:
    "The key is valid but not allowed to write this bucket or prefix: give it object read/write/delete on orgs/*.",
  remote_unavailable:
    "The store could not be reached or answered with a server error: check S3_ENDPOINT and retry.",
};

export function createPlatformAdmin(deps: PlatformAdminDeps): PlatformAdmin {
  const operators = new Set(deps.operatorEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const now = () => (deps.clock?.now() ?? new Date()).toISOString();
  let lastStorage: StorageTestResult | undefined;
  let lastCheck: MultixCheckResult | undefined;

  const vendorOf = (id: string): MultixVendor => {
    if (!(MULTIX_VENDORS as readonly string[]).includes(id)) {
      throw new StudixError("NOT_FOUND", `Unknown media vendor "${id}"`, {
        retryable: false,
        details: { known: [...MULTIX_VENDORS] },
      });
    }
    return id as MultixVendor;
  };
  const toVendor = (view: PlatformCredentialView): VendorView => ({
    ...view,
    vendor: view.id as MultixVendor,
    kinds: multixVendorRoles(view.id as MultixVendor),
  });

  async function checkMultix(vendor?: string): Promise<MultixCheckResult> {
    if (vendor) vendorOf(vendor);
    const status = deps.multix?.status();
    const keyFound: Record<string, boolean> = {};
    let result: MultixCheckResult;
    if (!deps.multix || !status?.enabled) {
      result = {
        ok: false,
        at: now(),
        diagnostic: "missing_executable",
        message: "MULTIX_BIN is not set on the app, so the Multix CLI cannot be run.",
        keyFound,
      };
    } else {
      // A fresh check, so a key saved a moment ago is visible; the cached one may predate it.
      deps.multix.invalidateCapabilities();
      const readiness = await deps.multix.readiness();
      for (const v of MULTIX_VENDORS) keyFound[v] = readiness[v] === true;
      const anyFound = Object.values(keyFound).some(Boolean);
      result = !deps.multix.checkRan()
        ? {
            ok: false,
            at: now(),
            diagnostic: "remote_unavailable",
            message:
              "multix check could not run (it timed out or failed). No key was judged missing; try again.",
            keyFound,
          }
        : {
            ok: vendor ? keyFound[vendor] === true : anyFound,
            at: now(),
            diagnostic: (vendor ? keyFound[vendor] === true : anyFound) ? "ok" : "missing_credential",
            message: anyFound
              ? "multix check ran. It reports whether a key is present; it does not spend money to prove the vendor accepts it."
              : "multix check found no vendor key, or could not run. Save a vendor key below, then check again.",
            keyFound,
          };
    }
    lastCheck = result;
    for (const v of MULTIX_VENDORS) {
      if (vendor && v !== vendor) continue;
      if (result.diagnostic === "missing_executable" || result.diagnostic === "remote_unavailable") continue;
      await deps.credentials.recordTest(v, {
        ok: keyFound[v] === true,
        outcome: keyFound[v] ? "found" : "missing",
      });
    }
    return result;
  }

  return {
    isOperator: (user) => user.emailVerified && operators.has(user.email.trim().toLowerCase()),

    async overview() {
      const status = deps.multix?.status();
      const views = await deps.credentials.list();
      return {
        storage: { ...deps.storageSettings, ...(lastStorage ? { lastTest: lastStorage } : {}) },
        multix: {
          enabled: status?.enabled === true,
          ...(deps.multixBin ? { bin: deps.multixBin } : {}),
          ...(status?.enabled === false && status.reason ? { reason: status.reason } : {}),
          models: { ...(status?.models ?? {}) },
          ...(lastCheck ? { lastCheck } : {}),
        },
        vendors: views.map(toVendor),
        apply: APPLY,
      };
    },

    async saveVendorKey(ctx, vendor, input) {
      const view = await deps.credentials.save(ctx, vendorOf(vendor), input);
      await deps.refreshCredentials().catch(() => undefined); // saved; the periodic reload applies it
      deps.multix?.invalidateCapabilities();
      return toVendor(view);
    },

    async revokeVendorKey(ctx, vendor) {
      const view = await deps.credentials.revoke(ctx, vendorOf(vendor));
      await deps.refreshCredentials().catch(() => undefined); // saved; the periodic reload applies it
      deps.multix?.invalidateCapabilities();
      return toVendor(view);
    },

    async testStorage() {
      const s = deps.storageSettings;
      let result: StorageTestResult;
      if (!deps.storage || !s.configured) {
        result = {
          ok: false,
          at: now(),
          diagnostic: "missing_credential",
          message: "S3_BUCKET is not set on the app, so object storage is not configured.",
        };
      } else if (!s.accessKeyId || s.secretAccessKey === "missing") {
        result = {
          ok: false,
          at: now(),
          diagnostic: "missing_credential",
          message: STORAGE_HINTS.missing_credential,
        };
      } else {
        const probe = await deps.storage.probeWrite();
        const diagnostic = classifyStorageProbe(probe);
        result = {
          ok: probe.ok,
          at: now(),
          diagnostic,
          ...(probe.step ? { step: probe.step } : {}),
          ...(probe.status === undefined ? {} : { status: probe.status }),
          ...(probe.s3Code ? { s3Code: probe.s3Code } : {}),
          message: STORAGE_HINTS[diagnostic],
        };
      }
      lastStorage = result;
      return result;
    },

    checkMultix,
  };
}

/** The Multix vendor ids and the environment variable each becomes in the CLI process. */
export const VENDOR_CREDENTIAL_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  MULTIX_VENDORS.map((v) => [v, MULTIX_VENDOR_KEYS[v]]),
);

/** Mask an access key id to its last four characters. */
const maskId = (id: string) => (id.length >= 12 ? `…${id.slice(-4)}` : "…");

/** The non-secret view of the S3_* settings; the secret access key is only reported as present or not. */
export function storageSettingsFromConfig(
  config: Pick<
    StudixConfig,
    | "S3_ENDPOINT"
    | "S3_BUCKET"
    | "S3_REGION"
    | "S3_FORCE_PATH_STYLE"
    | "S3_ACCESS_KEY_ID"
    | "S3_SECRET_ACCESS_KEY"
  >,
): StorageSettingsView {
  return {
    source: "env",
    configured: Boolean(config.S3_BUCKET),
    ...(config.S3_ENDPOINT ? { endpointHost: new URL(config.S3_ENDPOINT).host } : {}),
    ...(config.S3_BUCKET ? { bucket: config.S3_BUCKET } : {}),
    region: config.S3_REGION,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    ...(config.S3_ACCESS_KEY_ID ? { accessKeyId: maskId(config.S3_ACCESS_KEY_ID) } : {}),
    secretAccessKey: config.S3_SECRET_ACCESS_KEY ? "configured" : "missing",
  };
}
