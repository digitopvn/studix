import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type GeneratedMedia,
  type MediaCapability,
  type MediaCharge,
  MediaChargedError,
  type MediaCostSource,
  type MediaGenerationRequest,
  type MediaGenerationResult,
  type MediaJobJournal,
  type MediaJobRecord,
  type MediaKind,
  type MediaProvider,
  type MediaResumeRequest,
  type ProviderJobRef,
  type TenantContext,
} from "@studix/core";
import { type Clock, type StudixConfig, StudixError, systemClock, toStudixError } from "@studix/shared";
import { InMemoryMediaJobJournal } from "./media-job-journal.ts";
import { mediaBillingQuantity } from "./media-price-book.ts";
import {
  assertEstimateRequest,
  assertGenerationRequest,
  assertWithinBudget,
  throwIfAborted,
} from "./media-request-guards.ts";
import {
  createSpawnMultixRunner,
  type MultixEnvelope,
  type MultixRunner,
  multixRunError,
  multixRunSucceeded,
  parseMultixEnvelope,
  UNTRUSTED_OUTPUT_WARNINGS,
} from "./multix-cli-runner.ts";
import {
  DEFAULT_MULTIX_MODELS,
  MULTIX_VENDOR_KEYS,
  MULTIX_VENDORS,
  type MultixModelDefaults,
  type MultixPlan,
  type MultixRole,
  type MultixVendor,
  planMultixRequest,
  resolveMultixModel,
} from "./multix-routes.ts";

export const MULTIX_PROVIDER_ID = "multix";

export interface MultixProviderOptions {
  /** Path or name of the multix CLI (config.MULTIX_BIN). Absent means the provider is disabled. */
  bin?: string;
  /** How the CLI is executed; defaults to spawning `bin` without a shell. */
  runner?: MultixRunner;
  /** "<vendor>:<model>" overrides of the built-in defaults, per role. */
  models?: Partial<Record<MultixRole, string>>;
  /** Source of PATH, HOME and provider keys for the child; defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Let multix read ~/.multix/.env (local development only). */
  allowHomeEnv?: boolean;
  /** Longest wait for one upstream job. */
  waitTimeoutMs?: number;
  /**
   * Where submitted jobs are remembered when a request brings no `journal` of its own; defaults to a
   * process-local journal. Workflow stages pass their durable stage journal per request.
   */
  journal?: MediaJobJournal;
  clock?: Clock;
  /** How long capability probes (`multix check`, model catalogs) are reused. */
  capabilityTtlMs?: number;
}

export type MultixReadiness = Readonly<Record<MultixVendor, boolean>>;

export interface MultixProviderStatus {
  id: string;
  enabled: boolean;
  /** Why generation is unavailable, when it is. */
  reason?: string;
  models: MultixModelDefaults;
}

const DEFAULT_WAIT_MS = 900_000;
const DEFAULT_CAPABILITY_TTL_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 60_000;
/** Time the CLI gets beyond its own wait timeout to download outputs and print the envelope. */
const RUN_MARGIN_MS = 120_000;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CACHE_DIR = ".multix-cache";

/** Variables the child may see besides provider keys. Everything else in the worker env stays out. */
const PASSTHROUGH_ENV = [
  "PATH",
  "Path",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "ComSpec",
  "LANG",
  "LC_ALL",
  "TZ",
  "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
];

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
};

const OUTPUT_MIMES: Readonly<Record<Exclude<MediaKind, "audio">, string[]>> = {
  image: ["image/png", "image/jpeg", "image/webp"],
  video: ["video/mp4"],
  voice: ["audio/mpeg"],
  music: ["audio/mpeg"],
  sfx: ["audio/mpeg"],
  upscale: ["image/png", "image/jpeg", "image/webp", "video/mp4"],
};

const sha = (value: unknown, length = 16) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, length);
const toCents = (usd: number) => Math.ceil(usd * 100 - 1e-9);

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Key names `multix check` reports as found. Its `--json` envelope has no structured key list, only text
 * lines such as "✓ SUME_API_KEY found — <masked>" and "  FAL_KEY not set (optional)". Each line is cut at
 * the first "—" before matching, so the masked value is never read, kept or logged.
 */
export function parseCheckKeys(text: string | undefined): Set<string> {
  const keys = new Set<string>();
  for (const line of (text ?? "").split(/\r?\n/)) {
    const head = line.split("—", 1)[0]!;
    const match = /^\s*✓\s+([A-Z][A-Z0-9_]*)\s+found\b/.exec(head);
    if (match) keys.add(match[1]!);
  }
  return keys;
}

interface CatalogModels {
  image: string[];
  video: string[];
  videoUpscale: string[];
  voice: string[];
  music: string[];
}

/**
 * MediaProvider over the multix CLI. Image, video, lip-sync and video upscale run as Sume jobs; image
 * upscale as an Atlas Cloud prediction; speech, music and SFX on ElevenLabs, Fish or MiniMax. Every call
 * is a fixed argv (no shell) with a scrubbed environment, and every paid call is estimated and capped
 * first. Async jobs are journaled right after submission and collected with `status --wait --download`,
 * so a retry (or another worker) resumes the paid job instead of submitting a new one.
 */
export class MultixProvider implements MediaProvider {
  readonly id = MULTIX_PROVIDER_ID;
  private readonly bin: string | undefined;
  private readonly runner: MultixRunner | undefined;
  private readonly defaults: MultixModelDefaults;
  private readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  private readonly allowHomeEnv: boolean;
  private readonly waitTimeoutMs: number;
  private readonly journal: MediaJobJournal;
  private readonly clock: Clock;
  private readonly capabilityTtlMs: number;
  private probe: { at: number; value: Promise<MediaCapability[]> } | undefined;
  private lastReadiness: MultixReadiness | undefined;

  constructor(options: MultixProviderOptions = {}) {
    const bin = options.bin?.trim();
    this.bin = bin ? bin : undefined;
    this.runner = this.bin ? (options.runner ?? createSpawnMultixRunner(this.bin)) : undefined;
    this.defaults = { ...DEFAULT_MULTIX_MODELS, ...stripEmpty(options.models ?? {}) };
    for (const [role, model] of Object.entries(this.defaults)) {
      resolveMultixModel(
        { kind: kindOfRole(role as MultixRole), model, params: paramsOfRole(role as MultixRole) },
        this.defaults,
      );
    }
    this.sourceEnv = options.env ?? process.env;
    this.allowHomeEnv = options.allowHomeEnv ?? false;
    this.waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_MS;
    this.journal = options.journal ?? new InMemoryMediaJobJournal();
    this.clock = options.clock ?? systemClock;
    this.capabilityTtlMs = options.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS;
  }

  get enabled(): boolean {
    return this.runner !== undefined;
  }

  status(): MultixProviderStatus {
    return {
      id: this.id,
      enabled: this.enabled,
      ...(this.enabled ? {} : { reason: "MULTIX_BIN is not set" }),
      models: this.defaults,
    };
  }

  /** Which vendors have a key, per the last `multix check` (names only, never values). */
  async readiness(): Promise<MultixReadiness> {
    if (!this.enabled) return Object.fromEntries(MULTIX_VENDORS.map((v) => [v, false])) as MultixReadiness;
    await this.capabilities();
    return (
      this.lastReadiness ?? (Object.fromEntries(MULTIX_VENDORS.map((v) => [v, false])) as MultixReadiness)
    );
  }

  /** The "<vendor>:<model>" a request runs on; results report the same id. */
  resolveModel(request: Pick<MediaGenerationRequest, "kind" | "model" | "params">): string {
    return resolveMultixModel(request, this.defaults).model.id;
  }

  /** Kinds whose vendor key `multix check --json` reports, with models from the live catalogs. */
  async capabilities(): Promise<MediaCapability[]> {
    if (!this.enabled) return [];
    const now = this.clock.now().getTime();
    if (!this.probe || now - this.probe.at > this.capabilityTtlMs) {
      const value = this.probeCapabilities();
      this.probe = { at: now, value };
      value.catch(() => {
        if (this.probe?.value === value) this.probe = undefined;
      });
    }
    return this.probe.value;
  }

  async estimateCostCents(
    request: Omit<MediaGenerationRequest, "workDir" | "signal" | "idempotencyKey">,
  ): Promise<number> {
    assertEstimateRequest(request);
    this.assertEnabled();
    const plan = await planMultixRequest(request, undefined, this.planContext());
    return this.inScratchDir((dir) => this.estimatePlan(plan, request, dir));
  }

  /** Commands that write nothing run in a fresh private directory: multix reads a `.env` from its cwd. */
  private async inScratchDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "studix-multix-"));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async generate(ctx: TenantContext, request: MediaGenerationRequest): Promise<MediaGenerationResult> {
    const started = this.clock.now().getTime();
    assertGenerationRequest(request);
    this.assertEnabled();
    throwIfAborted(request.signal);
    const plan = await planMultixRequest(request, request.workDir, this.planContext());
    // The request's journal (the stage checkpoint) wins, so another worker resumes what this one paid for.
    const journal = request.journal ?? this.journal;
    const existing = await journal.get(ctx, request.idempotencyKey);
    if (existing && (existing.kind !== request.kind || existing.model !== plan.model.id)) {
      throw new StudixError("CONFLICT", "This idempotency key already ran a different media request", {
        details: { kind: existing.kind, model: existing.model },
      });
    }
    if (plan.mode === "sync") return this.runSync(ctx, journal, plan, request, existing, started);
    if (existing?.state === "submitting") {
      // The intent was written but no job id followed: the upstream may already have charged for it and
      // cannot deduplicate, so submitting again could pay twice.
      throw new StudixError(
        "PROVIDER_ERROR",
        "A previous submission of this request may already have been charged and cannot be deduplicated",
        {
          retryable: false,
          details: { provider: plan.model.vendor, model: existing.model, submittedAt: existing.submittedAt },
          suggestedAction:
            "Find the prediction in `multix history` or the provider console, then resume it by job id.",
        },
      );
    }
    if (existing?.job && existing.state !== "failed") {
      return this.collect(existing.job, plan.model.id, request.workDir, request.signal, started, {
        ctx,
        journal,
        record: existing,
      });
    }

    const estimate = await this.estimatePlan(plan, request, request.workDir);
    assertWithinBudget(estimate, request.maxCostCents, this.id);
    throwIfAborted(request.signal);
    const attempt = (existing?.attempt ?? 0) + 1;
    const at = this.clock.now().toISOString();
    const base = {
      idempotencyKey: request.idempotencyKey,
      kind: request.kind,
      model: plan.model.id,
      attempt,
      estimatedCostCents: estimate,
      submittedAt: at,
    };
    const job =
      plan.mode === "sume-job"
        ? await this.submitSume(ctx, plan, request, attempt)
        : await this.submitAtlas(plan, request, {
            intent: () => journal.put(ctx, { ...base, state: "submitting", updatedAt: at }),
            // Only errors proving the request never reached Atlas may release the key for a retry.
            release: () => journal.put(ctx, { ...base, state: "failed", updatedAt: at }),
          });
    const record: MediaJobRecord = { ...base, job, state: "submitted", updatedAt: at };
    await journal.put(ctx, record);
    return this.collect(job, plan.model.id, request.workDir, request.signal, started, {
      ctx,
      journal,
      record,
    });
  }

  /** Collect an upstream job by id without submitting anything (no new charge). */
  async resume(_ctx: TenantContext, request: MediaResumeRequest): Promise<MediaGenerationResult> {
    const started = this.clock.now().getTime();
    this.assertEnabled();
    const { job } = request;
    if (job.provider !== "sume" && job.provider !== "atlas") {
      throw new StudixError("VALIDATION", `Multix cannot resume jobs of "${job.provider}"`);
    }
    if (typeof job.id !== "string" || !JOB_ID.test(job.id)) {
      throw new StudixError("VALIDATION", "job.id is not a valid provider job id");
    }
    if (typeof request.workDir !== "string" || !isAbsolute(request.workDir)) {
      throw new StudixError("VALIDATION", "workDir must be an absolute path");
    }
    const estimated = request.estimatedCostCents;
    if (estimated !== undefined && (!Number.isInteger(estimated) || estimated < 0)) {
      throw new StudixError("VALIDATION", "estimatedCostCents must be a non-negative integer");
    }
    const model = request.model ?? `${job.provider}:unknown`;
    return this.collect(job, model, request.workDir, request.signal, started, {
      estimatedCostCents: estimated,
    });
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new StudixError("UNAVAILABLE", "The Multix provider is not configured", {
        retryable: false,
        suggestedAction: "Set MULTIX_BIN to the multix CLI on the worker, or use another provider.",
        details: { provider: this.id },
      });
    }
  }

  private planContext() {
    return { defaults: this.defaults, waitTimeoutMs: this.waitTimeoutMs };
  }

  private childEnv(cacheDir: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of [...PASSTHROUGH_ENV, ...Object.values(MULTIX_VENDOR_KEYS)]) {
      const value = this.sourceEnv[name];
      if (value !== undefined && value !== "") env[name] = value;
    }
    env.MULTIX_OUTPUT_DIR = cacheDir;
    if (!this.allowHomeEnv) env.MULTIX_DISABLE_HOME_ENV = "1";
    return env;
  }

  /** Run one command with --json and return its envelope; a failed run becomes a typed error. */
  private async exec(
    command: string,
    argv: readonly string[],
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<MultixEnvelope> {
    const { result, envelope } = await this.execRaw(argv, cwd, timeoutMs, signal);
    if (!multixRunSucceeded(result, envelope)) {
      throw multixRunError(command, result, envelope);
    }
    return envelope;
  }

  /** Run one command with --json and return what multix printed; judging success is the caller's job. */
  private async execRaw(
    argv: readonly string[],
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ result: Awaited<ReturnType<MultixRunner>>; envelope: MultixEnvelope | undefined }> {
    const cacheDir = join(cwd, `${CACHE_DIR}-${randomUUID()}`);
    let result: Awaited<ReturnType<MultixRunner>>;
    try {
      result = await this.runner!(argv, { cwd, env: this.childEnv(cacheDir), timeoutMs, signal });
    } finally {
      await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return { result, envelope: parseMultixEnvelope(result.stdout) };
  }

  private compose(plan: MultixPlan, extra: readonly string[]): string[] {
    return [...plan.argv, ...extra, "--json", ...(plan.operand !== undefined ? ["--", plan.operand] : [])];
  }

  private async estimatePlan(
    plan: MultixPlan,
    request: Pick<MediaGenerationRequest, "kind" | "prompt" | "params">,
    cwd: string,
  ): Promise<number> {
    if (plan.priced) {
      const envelope = await this.exec(
        `${plan.argv[0]} estimate`,
        this.compose(plan, ["--estimate"]),
        cwd,
        PROBE_TIMEOUT_MS,
      );
      if (envelope.estimateHighUsd !== undefined) return toCents(envelope.estimateHighUsd);
    }
    if (plan.assumed) {
      const { unit, quantity } = mediaBillingQuantity(request);
      const units = unit === plan.assumed.unit ? quantity : plan.assumed.defaultQuantity;
      return toCents(plan.assumed.usdPerUnit * units);
    }
    throw new StudixError("UNAVAILABLE", `No trusted price for ${plan.model.id}`, {
      retryable: false,
      suggestedAction: "Choose a model multix can price, or a default model with a known price.",
      details: { model: plan.model.id },
    });
  }

  /** `--max-cost` lets multix refuse too when it can prove the price itself. */
  private maxCostFlags(plan: MultixPlan, request: MediaGenerationRequest): string[] {
    return plan.priced
      ? [`--max-cost=${(request.maxCostCents / 100).toFixed(2)}`, "--cost-policy=strict"]
      : [];
  }

  private async submitSume(
    ctx: TenantContext,
    plan: MultixPlan,
    request: MediaGenerationRequest,
    attempt: number,
  ): Promise<ProviderJobRef> {
    // Derived per attempt: a crash before the journal write resubmits with the same key, and Sume returns
    // the job it already created instead of a second one.
    const key = `studix-${sha([ctx.workspaceId, request.idempotencyKey, attempt], 40)}`;
    const envelope = await this.exec(
      "sume submit",
      this.compose(plan, [`--idempotency-key=${key}`, ...this.maxCostFlags(plan, request)]),
      request.workDir,
      PROBE_TIMEOUT_MS * 10,
      request.signal,
    );
    const id = envelope.jobId ?? /Job submitted: (\S+)/.exec(envelope.text ?? "")?.[1];
    if (!id || !JOB_ID.test(id)) {
      throw new StudixError("PROVIDER_ERROR", "Sume accepted the request but multix reported no job id", {
        retryable: true,
        details: { historyId: envelope.historyId },
        suggestedAction: "Retry: the same idempotency key returns the job Sume already created.",
      });
    }
    return { provider: "sume", id };
  }

  /**
   * Atlas has no idempotency key, so the intent is journaled right before `atlas run`. A crash before the
   * job id is journaled then leaves a "submitting" record that blocks a blind resubmission.
   */
  private async submitAtlas(
    plan: MultixPlan,
    request: MediaGenerationRequest,
    journal: { intent: () => Promise<void>; release: () => Promise<void> },
  ): Promise<ProviderJobRef> {
    const atlas = plan.atlas!;
    const fields = { ...atlas.fields };
    for (const upload of atlas.uploads) {
      const envelope = await this.exec(
        "atlas upload",
        ["atlas", "upload", upload.path, "--json"],
        request.workDir,
        PROBE_TIMEOUT_MS * 5,
        request.signal,
      );
      const url = envelope.text?.trim();
      if (!url || !/^https:\/\/\S+$/.test(url)) {
        throw new StudixError("PROVIDER_ERROR", "Atlas Cloud returned no URL for an uploaded input");
      }
      fields[upload.field] = url;
    }
    if (fields.image === undefined) throw new StudixError("VALIDATION", "upscale needs params.image");
    throwIfAborted(request.signal);
    await journal.intent();
    let envelope: MultixEnvelope;
    try {
      envelope = await this.exec(
        "atlas submit",
        ["atlas", "run", atlas.modelId, `--input=${JSON.stringify(fields)}`, "--async", "--json"],
        request.workDir,
        PROBE_TIMEOUT_MS * 5,
        request.signal,
      );
    } catch (error) {
      if (error instanceof StudixError && (error.code === "VALIDATION" || error.code === "UNAVAILABLE")) {
        await journal.release().catch(() => undefined);
      }
      throw error;
    }
    const id = envelope.jobId ?? envelope.text?.trim();
    if (!id || !JOB_ID.test(id)) {
      // Atlas has no idempotency key: a blind retry could pay twice, so this is not retryable.
      throw new StudixError("PROVIDER_ERROR", "Atlas Cloud accepted the request but reported no job id", {
        retryable: false,
        details: { historyId: envelope.historyId },
        suggestedAction:
          "Find the prediction in `multix history` or the Atlas Cloud console before retrying.",
      });
    }
    return { provider: "atlas", id };
  }

  /** Wait for an upstream job and download its outputs: `status --wait --download`. */
  private async collect(
    job: ProviderJobRef,
    model: string,
    workDir: string,
    signal: AbortSignal | undefined,
    started: number,
    tracking:
      | { ctx: TenantContext; journal: MediaJobJournal; record: MediaJobRecord }
      | { estimatedCostCents?: number },
  ): Promise<MediaGenerationResult> {
    const outDir = join(
      workDir,
      `multix-${job.provider}-${job.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)}`,
    );
    await mkdir(outDir, { recursive: true });
    const wait = `--wait-timeout=${this.waitTimeoutMs}`;
    const argv =
      job.provider === "sume"
        ? ["sume", "status", job.id, "--wait", "--download", `--output=${outDir}`, wait, "--json"]
        : [
            "atlas",
            "status",
            job.id,
            "--download",
            `--output=${outDir}`,
            "--no-webp",
            "--no-thumb",
            wait,
            "--json",
          ];
    const record = "record" in tracking ? tracking.record : undefined;
    const fallback =
      record?.estimatedCostCents ??
      ("estimatedCostCents" in tracking ? tracking.estimatedCostCents : undefined);
    let envelope: MultixEnvelope;
    // Set once the job reported completion: from then on the upstream has charged, whatever fails next.
    let charge: MediaCharge | undefined;
    try {
      const { result, envelope: printed } = await this.execRaw(
        argv,
        outDir,
        this.waitTimeoutMs + RUN_MARGIN_MS,
        signal,
      );
      if (!multixRunSucceeded(result, printed)) {
        // `--wait --download` can exit non-zero after the job completed (the download failed). The error
        // envelope still carries the receipt: a positive one proves the job ended upstream and was kept.
        const unproven = printed as MultixEnvelope | undefined;
        if (unproven?.receiptUsd !== undefined && unproven.receiptUsd > 0 && !result.stoppedBy) {
          const [costCents, costSource] = this.settleCost(unproven, record?.receiptCents, fallback);
          charge = this.chargeOf(unproven, { provider: this.id, model, costCents, costSource, job });
        }
        throw multixRunError(`${job.provider} status`, result, printed);
      }
      envelope = printed;
      const [costCents, costSource] = this.settleCost(envelope, record?.receiptCents, fallback);
      charge = this.chargeOf(envelope, { provider: this.id, model, costCents, costSource, job });
      this.assertTrustedOutputs(envelope, job);
    } catch (err) {
      // A rejected Sume job ended upstream (Sume refunds it); the next attempt submits anew. Atlas gives
      // no such guarantee and cannot deduplicate, so an Atlas job always stays resumable. Anything else
      // (timeout, temporary failure, cancel) leaves the job running, and the record makes a retry resume it.
      if (
        job.provider === "sume" &&
        !charge &&
        "ctx" in tracking &&
        record &&
        err instanceof StudixError &&
        err.code === "PROVIDER_ERROR" &&
        !err.retryable
      ) {
        await tracking.journal
          .put(tracking.ctx, { ...record, state: "failed", updatedAt: this.clock.now().toISOString() })
          .catch((putErr: unknown) => {
            // A journal failure must not hide the charge the error already carries.
            if (charge) throw new MediaChargedError(toStudixError(putErr), charge);
            throw putErr;
          });
      }
      if (err instanceof StudixError) {
        const wrapped = new StudixError(err.code, err.message, {
          retryable: err.retryable,
          suggestedAction: err.suggestedAction,
          details: { ...err.details, job },
          cause: err,
        });
        throw charge ? new MediaChargedError(wrapped, charge) : wrapped;
      }
      throw err;
    }
    const [costCents, costSource] = this.settleCost(envelope, record?.receiptCents, fallback);
    const outputs = await this.outputsIn(envelope, outDir, outDir);
    if (outputs.length === 0) {
      const empty = new StudixError(
        "PROVIDER_ERROR",
        `${job.provider} job ${job.id} finished without outputs`,
        {
          retryable: false,
          details: { job },
        },
      );
      throw charge ? new MediaChargedError(empty, charge) : empty;
    }
    if ("ctx" in tracking && record) {
      await tracking.journal
        .put(tracking.ctx, {
          ...record,
          state: "completed",
          ...(costSource === "receipt" ? { receiptCents: costCents } : {}),
          updatedAt: this.clock.now().toISOString(),
        })
        .catch((putErr: unknown) => {
          throw charge ? new MediaChargedError(toStudixError(putErr), charge) : putErr;
        });
    }
    return {
      outputs,
      provider: this.id,
      model,
      costCents,
      costSource,
      latencyMs: Math.max(0, this.clock.now().getTime() - started),
      job,
    };
  }

  /** The charge to report when a finished call then fails; none when multix says it sent no request. */
  private chargeOf(envelope: MultixEnvelope, charge: MediaCharge): MediaCharge | undefined {
    return envelope.noRequest && envelope.receiptUsd === undefined ? undefined : charge;
  }

  /** The charge of a finished call: the receipt, else the journaled receipt, else the pre-call estimate. */
  private settleCost(
    envelope: MultixEnvelope,
    journaledReceiptCents: number | undefined,
    estimateCents: number | undefined,
  ): [number, MediaCostSource] {
    const receipt = envelope.receiptUsd === undefined ? undefined : toCents(envelope.receiptUsd);
    if (receipt !== undefined) return [receipt, "receipt"];
    if (journaledReceiptCents !== undefined) return [journaledReceiptCents, "receipt"];
    if (estimateCents !== undefined) return [estimateCents, "estimate"];
    return [0, "unknown"];
  }

  /** Synchronous audio: no upstream job to resume, so a completed output is reused from its fixed path. */
  private async runSync(
    ctx: TenantContext,
    journal: MediaJobJournal,
    plan: MultixPlan,
    request: MediaGenerationRequest,
    existing: MediaJobRecord | undefined,
    started: number,
  ): Promise<MediaGenerationResult> {
    const outDir = join(request.workDir, `multix-${sha([ctx.workspaceId, request.idempotencyKey])}`);
    const file = join(outDir, `${plan.role}${plan.outputExt ?? ".bin"}`);
    // One execution id per paid run: the upstream history id when it is a valid id, else one derived from
    // the idempotency key and the run's ordinal. The ordinal keeps a second paid run of the same key (the
    // output file was gone) from sharing the first run's usage line, which the ledger would drop.
    const execution = (historyId: string | undefined, ordinal: number): ProviderJobRef => ({
      provider: plan.model.vendor,
      id:
        historyId !== undefined && JOB_ID.test(historyId)
          ? historyId
          : `sync-${sha([ctx.workspaceId, request.idempotencyKey, ordinal], 24)}`,
    });
    const result = (
      outputs: GeneratedMedia[],
      costCents: number,
      costSource: MediaCostSource,
      job: ProviderJobRef,
    ) => ({
      outputs,
      provider: this.id,
      model: plan.model.id,
      costCents,
      costSource,
      job,
      latencyMs: Math.max(0, this.clock.now().getTime() - started),
    });
    if (existing?.state === "completed" && (await fileSize(file)) > 0) {
      // Records written before the id was derived hold the literal "sync".
      const journaled = existing.job?.id === "sync" ? undefined : existing.job?.id;
      return result(
        [{ filePath: file, mime: MIME_BY_EXT[extname(file)] ?? "application/octet-stream" }],
        existing.receiptCents ?? existing.estimatedCostCents,
        existing.receiptCents !== undefined ? "receipt" : "estimate",
        execution(journaled, existing.attempt),
      );
    }
    const estimate = await this.estimatePlan(plan, request, request.workDir);
    assertWithinBudget(estimate, request.maxCostCents, this.id);
    throwIfAborted(request.signal);
    await mkdir(outDir, { recursive: true });
    const envelope = await this.exec(
      plan.argv.slice(0, 2).join(" "),
      this.compose(plan, [...this.maxCostFlags(plan, request), `--output=${file}`]),
      outDir,
      plan.waitTimeoutMs + RUN_MARGIN_MS,
      request.signal,
    );
    // The run succeeded, so the upstream has charged even if its output turns out unusable.
    const [spentCents, spentSource] = this.settleCost(envelope, undefined, estimate);
    const charge = this.chargeOf(envelope, {
      provider: this.id,
      model: plan.model.id,
      costCents: spentCents,
      costSource: spentSource,
    });
    const failed = (error: StudixError) => (charge ? new MediaChargedError(error, charge) : error);
    try {
      this.assertTrustedOutputs(envelope);
    } catch (err) {
      throw err instanceof StudixError ? failed(err) : err;
    }
    const outputs = (await this.outputsIn(envelope, outDir, outDir)).filter((o) => o.filePath === file);
    if (outputs.length === 0) {
      throw failed(
        new StudixError("PROVIDER_ERROR", `multix ${plan.argv.slice(0, 2).join(" ")} wrote no output`, {
          retryable: false,
        }),
      );
    }
    const receipt = envelope.receiptUsd === undefined ? undefined : toCents(envelope.receiptUsd);
    const ran = execution(envelope.historyId, (existing?.attempt ?? 0) + 1);
    const at = this.clock.now().toISOString();
    await journal
      .put(ctx, {
        idempotencyKey: request.idempotencyKey,
        kind: request.kind,
        model: plan.model.id,
        job: ran,
        attempt: (existing?.attempt ?? 0) + 1,
        state: "completed",
        estimatedCostCents: estimate,
        ...(receipt !== undefined ? { receiptCents: receipt } : {}),
        submittedAt: at,
        updatedAt: at,
      })
      .catch((putErr: unknown) => {
        throw charge ? new MediaChargedError(toStudixError(putErr), charge) : putErr;
      });
    return result(outputs, receipt ?? estimate, receipt !== undefined ? "receipt" : "estimate", ran);
  }

  private assertTrustedOutputs(envelope: MultixEnvelope, job?: ProviderJobRef): void {
    const bad = envelope.warnings.filter((w) => UNTRUSTED_OUTPUT_WARNINGS.has(w));
    if (bad.length > 0) {
      throw new StudixError("PROVIDER_ERROR", `multix flagged the output: ${bad.join(", ")}`, {
        retryable: false,
        details: { warnings: bad, ...(job ? { job } : {}) },
      });
    }
  }

  /** Outputs multix reported that lie inside dir (copies in its cache are dropped). */
  private async outputsIn(envelope: MultixEnvelope, cwd: string, dir: string): Promise<GeneratedMedia[]> {
    const seen = new Set<string>();
    const media: GeneratedMedia[] = [];
    for (const output of envelope.outputs) {
      const filePath = resolve(cwd, output.path);
      const rel = relative(dir, filePath);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.startsWith(CACHE_DIR)) continue;
      if (seen.has(filePath) || (await fileSize(filePath)) === 0) continue;
      seen.add(filePath);
      const item: GeneratedMedia = {
        filePath,
        mime: output.mime ?? MIME_BY_EXT[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      };
      if (output.width !== undefined) item.width = output.width;
      if (output.height !== undefined) item.height = output.height;
      if (output.durationS !== undefined) item.durationMs = Math.round(output.durationS * 1000);
      media.push(item);
    }
    return media;
  }

  private probeCapabilities(): Promise<MediaCapability[]> {
    return this.inScratchDir((cwd) => this.probeCapabilitiesIn(cwd));
  }

  private async probeCapabilitiesIn(cwd: string): Promise<MediaCapability[]> {
    let keys: Set<string>;
    try {
      keys = parseCheckKeys((await this.exec("check", ["check", "--json"], cwd, PROBE_TIMEOUT_MS)).text);
    } catch {
      this.lastReadiness = undefined;
      return [];
    }
    const ready = Object.fromEntries(
      MULTIX_VENDORS.map((v) => [v, keys.has(MULTIX_VENDOR_KEYS[v])]),
    ) as Record<MultixVendor, boolean>;
    this.lastReadiness = ready;
    const catalog = await this.catalogModels(ready, cwd);
    const d = (role: MultixRole) =>
      resolveMultixModel(
        { kind: kindOfRole(role), model: this.defaults[role], params: paramsOfRole(role) },
        this.defaults,
      ).model;
    const pick = (role: MultixRole, live: string[]) => {
      const def = d(role);
      return ready[def.vendor] ? unique([def.id, ...live]) : live;
    };
    const vendorModels = (live: string[], role: MultixRole) =>
      pick(
        role,
        live.filter((id) => ready[id.slice(0, id.indexOf(":")) as MultixVendor]),
      );
    const capabilities: MediaCapability[] = [
      {
        kind: "image",
        models: ready.sume ? pick("image", catalog.image) : [],
        outputMimes: OUTPUT_MIMES.image,
      },
      {
        kind: "video",
        models: ready.sume ? unique([...pick("video", catalog.video), d("lipsync").id]) : [],
        outputMimes: OUTPUT_MIMES.video,
      },
      {
        kind: "upscale",
        models: unique([
          ...(ready.sume ? pick("videoUpscale", catalog.videoUpscale) : []),
          ...(ready[d("imageUpscale").vendor] ? [d("imageUpscale").id] : []),
        ]),
        outputMimes: OUTPUT_MIMES.upscale,
      },
      { kind: "voice", models: vendorModels(catalog.voice, "voice"), outputMimes: OUTPUT_MIMES.voice },
      { kind: "music", models: vendorModels(catalog.music, "music"), outputMimes: OUTPUT_MIMES.music },
      { kind: "sfx", models: ready.elevenlabs ? pick("sfx", []) : [], outputMimes: OUTPUT_MIMES.sfx },
    ];
    return capabilities.filter((c) => c.models.length > 0);
  }

  /** Model ids from the live catalogs; a catalog that cannot be read leaves only the configured defaults. */
  private async catalogModels(ready: Record<MultixVendor, boolean>, cwd: string): Promise<CatalogModels> {
    const models: CatalogModels = { image: [], video: [], videoUpscale: [], voice: [], music: [] };
    const read = async (argv: string[]) => {
      try {
        return (await this.exec(argv.slice(0, 2).join(" "), argv, cwd, PROBE_TIMEOUT_MS)).data;
      } catch {
        return undefined;
      }
    };
    if (ready.sume) {
      const data = await read(["sume", "models", "--json"]);
      const rows = isObject(data) && Array.isArray(data.models) ? data.models : [];
      for (const row of rows) {
        if (!isObject(row) || typeof row.id !== "string") continue;
        const id = `sume:${row.id}`;
        const modes = Array.isArray(row.modes) ? row.modes : [];
        const caps = isObject(row.capabilities) ? row.capabilities : {};
        if (row.kind === "image") models.image.push(id);
        else if (row.kind === "lipsync") models.video.push(id);
        else if (row.kind === "video" && caps.video_tool === "upscale") models.videoUpscale.push(id);
        else if (
          row.kind === "video" &&
          (modes.includes("text-to-video") || modes.includes("image-to-video"))
        ) {
          models.video.push(id);
        }
      }
    }
    const audio = async (task: string, into: string[]) => {
      if (!ready.elevenlabs && !ready.fish && !ready.minimax) return;
      const data = await read(["models", `--task=${task}`, "--json"]);
      for (const row of Array.isArray(data) ? data : []) {
        if (!isObject(row) || !["elevenlabs", "fish", "minimax"].includes(String(row.provider))) continue;
        const command = String(row.command ?? "");
        if (!/^(elevenlabs (tts|music)|fish tts|minimax generate-(speech|music))$/.test(command)) continue;
        const ids = [row.default_model, ...(Array.isArray(row.models) ? row.models : [])];
        for (const m of ids) if (typeof m === "string" && m !== "") into.push(`${row.provider}:${m}`);
      }
    };
    await audio("speech", models.voice);
    await audio("music", models.music);
    return models;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function stripEmpty(models: Partial<Record<MultixRole, string>>): Partial<Record<MultixRole, string>> {
  return Object.fromEntries(
    Object.entries(models).filter(([, v]) => typeof v === "string" && v.trim() !== ""),
  );
}

/** A representative kind and params per role, to validate configured defaults through the same parser. */
function kindOfRole(role: MultixRole): MediaKind {
  if (role === "lipsync") return "video";
  if (role === "imageUpscale" || role === "videoUpscale") return "upscale";
  return role;
}

function paramsOfRole(role: MultixRole): Record<string, unknown> {
  if (role === "lipsync") return { audio: "x" };
  if (role === "imageUpscale") return { image: "x" };
  if (role === "videoUpscale") return { video: "x" };
  return {};
}

async function fileSize(path: string): Promise<number> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : 0;
  } catch {
    return 0;
  }
}

export function createMultixProviderFromConfig(
  config: Pick<
    StudixConfig,
    | "MULTIX_BIN"
    | "MULTIX_IMAGE_MODEL"
    | "MULTIX_VIDEO_MODEL"
    | "MULTIX_LIPSYNC_MODEL"
    | "MULTIX_VOICE_MODEL"
    | "MULTIX_MUSIC_MODEL"
    | "MULTIX_SFX_MODEL"
    | "MULTIX_IMAGE_UPSCALE_MODEL"
    | "MULTIX_VIDEO_UPSCALE_MODEL"
    | "MULTIX_ALLOW_HOME_ENV"
    | "MULTIX_WAIT_TIMEOUT_SECONDS"
  >,
  options: Omit<MultixProviderOptions, "bin" | "models" | "allowHomeEnv" | "waitTimeoutMs"> = {},
): MultixProvider {
  const models: Partial<Record<MultixRole, string>> = {};
  const set = (role: MultixRole, value: string | undefined) => {
    if (value) models[role] = value;
  };
  set("image", config.MULTIX_IMAGE_MODEL);
  set("video", config.MULTIX_VIDEO_MODEL);
  set("lipsync", config.MULTIX_LIPSYNC_MODEL);
  set("voice", config.MULTIX_VOICE_MODEL);
  set("music", config.MULTIX_MUSIC_MODEL);
  set("sfx", config.MULTIX_SFX_MODEL);
  set("imageUpscale", config.MULTIX_IMAGE_UPSCALE_MODEL);
  set("videoUpscale", config.MULTIX_VIDEO_UPSCALE_MODEL);
  return new MultixProvider({
    ...options,
    bin: config.MULTIX_BIN,
    models,
    allowHomeEnv: config.MULTIX_ALLOW_HOME_ENV,
    waitTimeoutMs: config.MULTIX_WAIT_TIMEOUT_SECONDS * 1000,
  });
}
