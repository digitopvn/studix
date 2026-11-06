/**
 * Deploys TOSE projects from CI. With TOSE_IMAGE (a digest built by CI) it deploys that image to each
 * project in order, app first. Otherwise it triggers a build of each project's connected branch, all at once,
 * and waits until every deployment is live. In branch mode TOSE builds from Git itself; this script only
 * starts the build (projects have auto-deploy off) and reports the outcome.
 *
 *   TOSE_API_KEY=... TOSE_WORKSPACE=wearetopgroup node deploy/tose/deploy.ts studix-prod-app studix-prod-worker
 *
 * TOSE always builds the branch tip, not a given commit. With EXPECTED_SHA (the pushed commit)
 * plus GITHUB_REPOSITORY, GITHUB_REF_NAME and GITHUB_TOKEN, the script skips a build when the tip
 * has moved on (the newer push's own run deploys it after its CI) and fails if TOSE still built
 * another commit, so an unexpected commit never goes out unnoticed.
 * TOSE_DEPLOY_TIMEOUT_SECONDS bounds the wait per project (default 1800).
 * Never prints the API key; logs project, deployment id, commit and status only.
 */

const API = process.env.TOSE_API_URL ?? "https://api-v2.tose.sh";
const apiKey = required("TOSE_API_KEY");
const workspace = required("TOSE_WORKSPACE");
const expectedSha = process.env.EXPECTED_SHA;
// A digest-pinned image built by CI (registry/repo@sha256:...). Set: TOSE deploys it as is, no TOSE build.
const image = process.env.TOSE_IMAGE;
if (image && !/@sha256:[0-9a-f]{64}$/.test(image)) throw new Error("TOSE_IMAGE must be pinned by digest");
const registryCredentialId = process.env.TOSE_REGISTRY_CREDENTIAL_ID || undefined;
const timeoutSeconds = Number(process.env.TOSE_DEPLOY_TIMEOUT_SECONDS ?? 1800);
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  throw new Error("TOSE_DEPLOY_TIMEOUT_SECONDS must be a positive number");
}
const POLL_MS = 10_000;
// Statuses the TOSE CLI knows: pending, building, deploying, running (live), failed, stopped.
const FAILED = new Set(["failed", "error", "stopped", "cancelled", "canceled"]);

interface Deployment {
  id: string;
  status: string;
  git_commit_sha?: string;
  git_branch?: string;
  error_message?: string | null;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The API answers bare, as `{deployment}` or as `{success, data}` (the shape the TOSE CLI unwraps). */
function unwrapDeployment(body: unknown, what: string): Deployment {
  let value = body as Record<string, unknown> | null;
  if (value?.success === false)
    throw new Error(`${what}: ${String(value.error ?? value.message ?? "rejected")}`);
  if (value?.data && typeof value.data === "object") value = value.data as Record<string, unknown>;
  if (value?.deployment && typeof value.deployment === "object")
    value = value.deployment as Record<string, unknown>;
  if (typeof value?.id !== "string" || typeof value.status !== "string") {
    throw new Error(`${what}: unexpected response shape`);
  }
  return value as unknown as Deployment;
}

async function call(method: string, path: string, body: object = {}): Promise<unknown> {
  const res = await fetch(`${API}/api/workspaces/${workspace}/projects/${path}`, {
    method,
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw Object.assign(new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`), {
      retryable: res.status >= 500,
    });
  }
  // Commit messages can carry raw control characters that make the JSON invalid.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return JSON.parse(text.replace(/[\u0000-\u001f]/g, " "));
}

/** Reads are retried on network errors and 5xx (the API sits behind Cloudflare). */
async function read(path: string): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call("GET", path);
    } catch (error) {
      const retryable = (error as { retryable?: boolean }).retryable ?? true;
      if (!retryable || attempt === 4) throw error;
      await sleep(attempt * 3000);
    }
  }
}

/** The commit at the tip of the deployed branch, or undefined outside GitHub Actions. */
async function branchTip(): Promise<string | undefined> {
  const { GITHUB_REPOSITORY: repo, GITHUB_REF_NAME: branch, GITHUB_TOKEN: token } = process.env;
  if (!repo || !branch || !token) return undefined;
  const res = await fetch(`https://api.github.com/repos/${repo}/branches/${encodeURIComponent(branch)}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub branch lookup: HTTP ${res.status}`);
  return ((await res.json()) as { commit: { sha: string } }).commit.sha;
}

async function deploy(project: string): Promise<void> {
  const started = Date.now();
  // Not retried: a POST that timed out may still have started a deploy, and a retry would start a second one.
  let deployment = unwrapDeployment(
    image
      ? await call("POST", `${project}/deploy-image`, {
          image,
          registry_credential_id: registryCredentialId,
        })
      : await call("POST", `${project}/deploy`),
    `${project} deploy`,
  );
  console.log(`${project}: deployment ${deployment.id} started (${deployment.status})`);
  while (deployment.status !== "running") {
    if (FAILED.has(deployment.status)) {
      throw new Error(
        `${project}: deployment ${deployment.id} ${deployment.status}: ${deployment.error_message ?? "no message"}`,
      );
    }
    if (Date.now() - started > timeoutSeconds * 1000) {
      throw new Error(
        `${project}: deployment ${deployment.id} still ${deployment.status} after ${timeoutSeconds}s`,
      );
    }
    await sleep(POLL_MS);
    deployment = unwrapDeployment(
      await read(`${project}/deployments/${deployment.id}`),
      `${project} deployment`,
    );
  }
  if (image) {
    console.log(`${project}: live in ${Math.round((Date.now() - started) / 1000)}s, ${image}`);
    return;
  }
  const sha = deployment.git_commit_sha ?? "unknown";
  console.log(
    `${project}: live in ${Math.round((Date.now() - started) / 1000)}s, ${deployment.git_branch ?? "?"}@${sha.slice(0, 7)}`,
  );
  if (expectedSha && sha !== expectedSha) {
    throw new Error(
      `${project}: TOSE built ${sha.slice(0, 7)}, not the pushed ${expectedSha.slice(0, 7)}; check this deploy`,
    );
  }
}

const projects = process.argv.slice(2);
if (projects.length === 0) throw new Error("usage: node deploy/tose/deploy.ts <project>...");
if (image) {
  // The image is exactly the pushed commit and rolls out in a minute or two, so keep the safe order:
  // the app applies migrations on start, then the worker.
  for (const project of projects) await deploy(project);
} else {
  await deployBranchTip();
}

/** Without TOSE_IMAGE, TOSE builds each project's branch tip itself. */
async function deployBranchTip(): Promise<void> {
  const tip = expectedSha ? await branchTip() : undefined;
  if (expectedSha && tip && tip !== expectedSha) {
    console.log(
      `::notice::branch is at ${tip.slice(0, 7)}, not the pushed ${expectedSha.slice(0, 7)}; the newer push's run deploys it`,
    );
  } else {
    // In parallel: each project builds the same image, so sequential builds doubled the wait. The app
    // still migrates on start. If the worker goes live first, code that needs the new schema can fail
    // until the app has migrated (usually seconds, both builds take about as long); see
    // docs/DEPLOYMENT.md#ci-deploy for this trade-off.
    const results = await Promise.allSettled(projects.map(deploy));
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    for (const failure of failures) console.error(failure.reason);
    if (failures.length > 0) process.exit(1);
  }
}
