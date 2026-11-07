import { createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { SecretBox } from "@studix/auth";
import { type ActorRef, assertPermission, type TenantContext } from "@studix/core";
import type { JobChange, WorkspaceWebhookRepository } from "@studix/database";
import { type Logger, StudixError } from "@studix/shared";
import { blockedAddressReason } from "@studix/storage";

/** Header carrying `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`. */
export const WEBHOOK_SIGNATURE_HEADER = "studix-signature";
/** Stable id of one event (`<jobId>:<status>:<updatedAt ms>`); deliveries are at least once, dedupe on it. */
export const WEBHOOK_EVENT_ID_HEADER = "studix-event-id";
const DELIVERY_TIMEOUT_MS = 5_000;

export interface JobWebhookEvent {
  type: "job.status";
  eventId: string;
  jobId: string;
  projectId: string | null;
  status: JobChange["status"];
  stage: string | null;
  progress: number;
  at: string;
}

export interface WebhookView {
  url: string;
  secretHint: string;
  updatedAt: Date;
  updatedBy?: ActorRef;
}

export interface JobWebhookService {
  get(ctx: TenantContext): Promise<WebhookView | null>;
  /** Save the URL with a new signing secret, returned once in `secret`. */
  set(ctx: TenantContext, url: string): Promise<WebhookView & { secret: string }>;
  remove(ctx: TenantContext): Promise<{ removed: boolean }>;
  /** Send status changes to the webhooks of their workspaces. Never throws. */
  deliver(changes: readonly JobChange[]): Promise<void>;
}

/** `t=…,v1=…` for a raw body; receivers recompute it with their secret and compare in constant time. */
export function signWebhook(secret: string, body: string, unixSeconds: number): string {
  const mac = createHmac("sha256", secret).update(`${unixSeconds}.${body}`).digest("hex");
  return `t=${unixSeconds},v1=${mac}`;
}

export function webhookEvent(change: JobChange): JobWebhookEvent {
  return {
    type: "job.status",
    eventId: `${change.id}:${change.status}:${change.updatedAt.getTime()}`,
    jobId: change.id,
    projectId: change.projectId,
    status: change.status,
    stage: change.stage,
    progress: change.progress,
    at: change.updatedAt.toISOString(),
  };
}

const invalid = (message: string) => new StudixError("VALIDATION", message);

/** The URL must be https (http only with allowLocal) and resolve to public addresses only. */
async function assertSafeWebhookUrl(raw: string, allowLocal: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid("Webhook URL is not a valid URL");
  }
  if (url.protocol !== "https:" && !(allowLocal && url.protocol === "http:"))
    throw invalid("Webhook URL must use https");
  if (url.username || url.password) throw invalid("Webhook URL must not carry credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host)
      ? [host]
      : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  } catch {
    throw invalid("Webhook hostname does not resolve");
  }
  if (addresses.length === 0 || addresses.some((a) => blockedAddressReason(a, { allowLocal })))
    throw invalid("Webhook URL resolves to a private or reserved address");
  return url;
}

const hintOf = (secret: string) => `${secret.slice(0, 6)}…${secret.slice(-4)}`;
const aad = (workspaceId: string) => `workspace-webhook:${workspaceId}`;

export function createJobWebhookService(deps: {
  repo: WorkspaceWebhookRepository;
  secrets: SecretBox | undefined;
  logger: Logger;
  allowLocal: boolean;
  fetch?: typeof fetch;
}): JobWebhookService {
  const send = deps.fetch ?? fetch;
  const box = () => {
    if (!deps.secrets)
      throw new StudixError("UNAVAILABLE", "STUDIX_SECRETS_KEY is not set; webhooks are off");
    return deps.secrets;
  };
  const view = (r: {
    url: string;
    secretHint: string;
    updatedAt: Date;
    updatedBy?: ActorRef;
  }): WebhookView => ({
    url: r.url,
    secretHint: r.secretHint,
    updatedAt: r.updatedAt,
    ...(r.updatedBy ? { updatedBy: r.updatedBy } : {}),
  });

  const post = async (url: string, secret: string, event: JobWebhookEvent) => {
    await assertSafeWebhookUrl(url, deps.allowLocal);
    const body = JSON.stringify(event);
    const res = await send(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "user-agent": "Studix-Webhook/1",
        [WEBHOOK_EVENT_ID_HEADER]: event.eventId,
        [WEBHOOK_SIGNATURE_HEADER]: signWebhook(secret, body, Math.floor(Date.now() / 1000)),
      },
      body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  };

  return {
    async get(ctx) {
      assertPermission(ctx, "workspace:read");
      const row = await deps.repo.get(ctx);
      return row ? view(row) : null;
    },
    async set(ctx, rawUrl) {
      assertPermission(ctx, "apikey:manage");
      const url = await assertSafeWebhookUrl(rawUrl.trim(), deps.allowLocal);
      const secret = `whsec_${randomBytes(24).toString("base64url")}`;
      const row = await deps.repo.put(
        ctx,
        {
          url: url.toString(),
          secretCiphertext: box().seal(secret, aad(ctx.workspaceId)),
          secretHint: hintOf(secret),
        },
        { type: ctx.actor.type, id: ctx.actor.id } as ActorRef,
      );
      return { ...view(row), secret };
    },
    async remove(ctx) {
      assertPermission(ctx, "apikey:manage");
      return { removed: await deps.repo.remove(ctx) };
    },
    async deliver(changes) {
      if (changes.length === 0 || !deps.secrets) return;
      try {
        const hooks = await deps.repo.listForWorkspaces([...new Set(changes.map((c) => c.workspaceId))]);
        const byWorkspace = new Map(hooks.map((h) => [h.workspaceId, h]));
        await Promise.all(
          changes.map(async (change) => {
            const hook = byWorkspace.get(change.workspaceId);
            if (!hook) return;
            const event = webhookEvent(change);
            try {
              await post(hook.url, box().open(hook.secretCiphertext, aad(hook.workspaceId)), event);
            } catch (err) {
              deps.logger.warn("webhook delivery failed", {
                workspaceId: change.workspaceId,
                jobId: change.id,
                eventId: event.eventId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }),
        );
      } catch (err) {
        deps.logger.warn("webhook lookup failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
