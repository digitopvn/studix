import { StudixError } from "@studix/shared";
import { z } from "zod";

/*
 * "Sign in with ChatGPT" for the Codex runtime: the OAuth device-code flow of the Codex CLI
 * (`codex login --device-auth`), run by the server so the user only types a code on auth.openai.com. The
 * resulting tokens are what the CLI keeps in `$CODEX_HOME/auth.json`; Studix stores them sealed as one
 * provider connection and writes them into a task's scratch CODEX_HOME only for the run.
 */

export const CHATGPT_ISSUER = "https://auth.openai.com";
/** The Codex CLI's public OAuth client (no secret, PKCE). */
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_VERIFICATION_URL = `${CHATGPT_ISSUER}/codex/device`;

/** The tokens of one ChatGPT login, as `auth.json` stores them. */
export const ChatGptTokens = z.object({
  idToken: z.string().min(20).max(20_000),
  accessToken: z.string().min(20).max(20_000),
  refreshToken: z.string().min(8).max(4_000),
  accountId: z.string().min(1).max(200).optional(),
  lastRefresh: z.string().datetime(),
});
export type ChatGptTokens = z.infer<typeof ChatGptTokens>;

export interface ChatGptDeviceCode {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
}

export type ChatGptPollResult = { status: "pending" } | { status: "authorized"; tokens: ChatGptTokens };

export interface ChatGptAuthClient {
  requestDeviceCode(): Promise<ChatGptDeviceCode>;
  /** One poll; `pending` until the user has entered the code. */
  poll(code: Pick<ChatGptDeviceCode, "deviceAuthId" | "userCode">): Promise<ChatGptPollResult>;
  /** New tokens for a refresh token. OpenAI rotates the refresh token, so the result must be stored. */
  refresh(refreshToken: string): Promise<ChatGptTokens>;
}

const UserCodeResponse = z.object({
  device_auth_id: z.string().min(1),
  user_code: z.string().min(1).optional(),
  usercode: z.string().min(1).optional(),
  interval: z.union([z.number(), z.string()]).optional(),
});
const DeviceTokenResponse = z.object({
  authorization_code: z.string().min(1),
  code_verifier: z.string().min(1),
});
const TokenResponse = z.object({
  id_token: z.string().min(1),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
});

/** The ChatGPT account id the Codex CLI sends with its requests, from the id token's claims. */
export function chatGptAccountId(idToken: string): string | undefined {
  const payload = idToken.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = claims["https://api.openai.com/auth"] as { chatgpt_account_id?: unknown } | undefined;
    return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

/** The email of a ChatGPT login, for the connection's default label; never used for anything else. */
export function chatGptEmail(idToken: string): string | undefined {
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof claims?.email === "string" ? claims.email.slice(0, 60) : undefined;
  } catch {
    return undefined;
  }
}

/** `auth.json` for a Codex CLI that runs on this login. */
export function codexAuthJson(tokens: ChatGptTokens): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      ...(tokens.accountId ? { account_id: tokens.accountId } : {}),
    },
    last_refresh: tokens.lastRefresh,
  });
}

/** Reads back an `auth.json` the CLI may have refreshed during a run; undefined when it is not a login. */
export function tokensFromCodexAuthJson(text: string): ChatGptTokens | undefined {
  try {
    const raw = JSON.parse(text) as {
      tokens?: { id_token?: string; access_token?: string; refresh_token?: string; account_id?: string };
      last_refresh?: string;
    };
    const parsed = ChatGptTokens.safeParse({
      idToken: raw.tokens?.id_token,
      accessToken: raw.tokens?.access_token,
      refreshToken: raw.tokens?.refresh_token,
      ...(raw.tokens?.account_id ? { accountId: raw.tokens.account_id } : {}),
      lastRefresh: raw.last_refresh,
    });
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function failure(step: string, status: number): StudixError {
  const rejected = status === 400 || status === 401;
  return new StudixError(
    rejected ? "VALIDATION" : "PROVIDER_ERROR",
    `ChatGPT sign-in failed (${step}, HTTP ${status})`,
    {
      retryable: !rejected,
      suggestedAction: rejected ? "Start the ChatGPT sign-in again." : "Try again in a moment.",
      details: { httpStatus: status },
    },
  );
}

export function createChatGptAuthClient(
  options: { fetch?: typeof fetch; issuer?: string } = {},
): ChatGptAuthClient {
  const http = options.fetch ?? fetch;
  const issuer = options.issuer ?? CHATGPT_ISSUER;
  const signal = () => AbortSignal.timeout(20_000);

  async function exchange(body: URLSearchParams | Record<string, string>, previousRefresh?: string) {
    const form = body instanceof URLSearchParams;
    const res = await http(`${issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
      body: form ? body.toString() : JSON.stringify(body),
      signal: signal(),
    });
    if (!res.ok) throw failure("token", res.status);
    const parsed = TokenResponse.parse(await res.json());
    const refreshToken = parsed.refresh_token ?? previousRefresh;
    if (!refreshToken) throw failure("token", 502);
    const accountId = chatGptAccountId(parsed.id_token);
    return ChatGptTokens.parse({
      idToken: parsed.id_token,
      accessToken: parsed.access_token,
      refreshToken,
      ...(accountId ? { accountId } : {}),
      lastRefresh: new Date().toISOString(),
    });
  }

  return {
    async requestDeviceCode() {
      const res = await http(`${issuer}/api/accounts/deviceauth/usercode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
        signal: signal(),
      });
      if (!res.ok) throw failure("device code", res.status);
      const parsed = UserCodeResponse.parse(await res.json());
      const userCode = parsed.user_code ?? parsed.usercode;
      if (!userCode) throw failure("device code", 502);
      const interval = Number(parsed.interval ?? 5);
      return {
        deviceAuthId: parsed.device_auth_id,
        userCode,
        intervalSeconds: Number.isFinite(interval) ? Math.min(30, Math.max(2, interval)) : 5,
      };
    },

    async poll(code) {
      const res = await http(`${issuer}/api/accounts/deviceauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_auth_id: code.deviceAuthId, user_code: code.userCode }),
        signal: signal(),
      });
      // The user has not entered the code yet.
      if (res.status === 403 || res.status === 404) return { status: "pending" };
      if (!res.ok) throw failure("device poll", res.status);
      const grant = DeviceTokenResponse.parse(await res.json());
      const tokens = await exchange(
        new URLSearchParams({
          grant_type: "authorization_code",
          code: grant.authorization_code,
          redirect_uri: `${issuer}/deviceauth/callback`,
          client_id: CODEX_OAUTH_CLIENT_ID,
          code_verifier: grant.code_verifier,
        }),
      );
      return { status: "authorized", tokens };
    },

    refresh(refreshToken) {
      return exchange(
        {
          client_id: CODEX_OAUTH_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          scope: "openid profile email",
        },
        refreshToken,
      );
    },
  };
}
