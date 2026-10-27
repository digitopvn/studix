/**
 * End-to-end smoke against a running Studix deployment (self-host or staging):
 * sign up a throwaway dashboard user, create a workspace API key, call `/mcp`
 * `studix_create_video` with a Vietnamese prompt, poll `studix_get_job` and download the MP4.
 *
 *   STUDIX_SMOKE_URL=https://app.example.com pnpm --filter @studix/mcp-server smoke
 *
 * Prints ids, timings and sizes only; the API key and password never leave this process.
 */
import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const base = (process.env.STUDIX_SMOKE_URL ?? "http://localhost:58080").replace(/\/+$/, "");
const prompt =
  process.env.STUDIX_SMOKE_PROMPT ??
  "Làm video giới thiệu thương hiệu cà phê Sương Mai: rang mộc mỗi sáng, vị đậm đà, giao tận nơi trong 30 phút. Đặt ngay hôm nay!";
const timeoutMs = Number(process.env.STUDIX_SMOKE_TIMEOUT_MS ?? 600_000);

interface Envelope {
  status: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; suggestedAction?: string };
}

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function createApiKey(): Promise<string> {
  const id = randomBytes(6).toString("hex");
  const signUp = await post("/api/auth/sign-up/email", {
    email: `smoke-${id}@studix.invalid`,
    password: randomBytes(24).toString("base64url"),
    name: `smoke-${id}`,
  });
  if (signUp.status !== 200) throw new Error(`sign-up failed with HTTP ${signUp.status}`);
  const cookie = signUp.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const created = await post("/api/api-keys", { name: `smoke-${id}` }, cookie);
  if (created.status !== 201) throw new Error(`api key creation failed with HTTP ${created.status}`);
  return ((await created.json()) as { secret: string }).secret;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Envelope> {
  const result = await client.callTool({ name, arguments: args });
  return result.structuredContent as unknown as Envelope;
}

const started = Date.now();
const health = await fetch(`${base}/healthz`);
console.log(`healthz: HTTP ${health.status}`);
const key = await createApiKey();
const client = new Client({ name: "studix-smoke", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  }),
);
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log(`tools/list: ${tools.length} tools (${tools.join(", ")})`);

const created = await call(client, "studix_create_video", { prompt, idempotencyKey: `smoke-${started}` });
if (created.status !== "ok") throw new Error(`create_video failed: ${JSON.stringify(created.error)}`);
const jobId = String(created.data?.jobId);
console.log(`job ${jobId} created for project ${String(created.data?.projectId)}`);

let job: Record<string, unknown> = {};
while (Date.now() - started < timeoutMs) {
  const env = await call(client, "studix_get_job", { jobId });
  if (env.status !== "ok") throw new Error(`get_job failed: ${JSON.stringify(env.error)}`);
  job = env.data ?? {};
  if (["succeeded", "failed", "cancelled"].includes(String(job.status))) break;
  await new Promise((r) => setTimeout(r, 2000));
}
const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (job.status !== "succeeded")
  throw new Error(`job ended ${String(job.status)}: ${JSON.stringify(job.error)}`);
const video = job.video as { url: string } | undefined;
if (!video?.url) throw new Error("job succeeded without a video url");
const mp4 = await fetch(video.url);
const bytes = (await mp4.arrayBuffer()).byteLength;
console.log(
  `job ${jobId} succeeded in ${seconds}s; video HTTP ${mp4.status}, ${mp4.headers.get("content-type")}, ${bytes} bytes`,
);
await client.close();
