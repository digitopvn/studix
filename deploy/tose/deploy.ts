/**
 * Deploys TOSE projects from CI: triggers a build of each project's connected branch, in the order
 * given, and waits until that deployment is live. TOSE builds from Git itself; this script only
 * starts the build after CI passed (projects have auto-deploy off) and reports the outcome.
 *
 *   TOSE_API_KEY=... TOSE_WORKSPACE=wearetopgroup node deploy/tose/deploy.ts studix-prod-app studix-prod-worker
 *
 * Optional: EXPECTED_SHA warns when TOSE built a different commit (a newer push on the branch),
 * TOSE_DEPLOY_TIMEOUT_SECONDS bounds the wait per project (default 1800).
 * Never prints the API key; logs project, deployment id, commit and status only.
 */

const API = process.env.TOSE_API_URL ?? "https://api-v2.tose.sh";
const apiKey = required("TOSE_API_KEY");
const workspace = required("TOSE_WORKSPACE");
const expectedSha = process.env.EXPECTED_SHA;
const timeoutMs = Number(process.env.TOSE_DEPLOY_TIMEOUT_SECONDS ?? 1800) * 1000;
const POLL_MS = 10_000;
const FAILED = new Set(["failed", "error", "stopped", "cancelled", "canceled", "superseded"]);

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

/** TOSE API call with retries on network errors and 5xx (the API sits behind Cloudflare). */
async function tose<T>(method: string, path: string): Promise<T> {
  const url = `${API}/api/workspaces/${workspace}/projects/${path}`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { "X-API-Key": apiKey },
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok)
        throw Object.assign(new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`), {
          fatal: true,
        });
      // Commit messages can carry raw control characters that make the JSON invalid.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
      return JSON.parse(text.replace(/[\u0000-\u001f]/g, " ")) as T;
    } catch (error) {
      if ((error as { fatal?: boolean }).fatal) throw error;
      lastError = error;
      await sleep(attempt * 3000);
    }
  }
  throw new Error(`${method} ${path} failed after retries: ${String(lastError)}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function deploy(project: string): Promise<void> {
  const started = Date.now();
  const triggered = await tose<Deployment & { deployment?: Deployment }>("POST", `${project}/deploy`);
  let deployment = triggered.deployment ?? triggered;
  console.log(`${project}: deployment ${deployment.id} started (${deployment.status})`);
  while (deployment.status !== "running") {
    if (FAILED.has(deployment.status)) {
      throw new Error(
        `${project}: deployment ${deployment.id} ${deployment.status}: ${deployment.error_message ?? "no message"}`,
      );
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `${project}: deployment ${deployment.id} still ${deployment.status} after ${timeoutMs / 1000}s`,
      );
    }
    await sleep(POLL_MS);
    deployment = await tose<Deployment>("GET", `${project}/deployments/${deployment.id}`);
  }
  const sha = deployment.git_commit_sha ?? "unknown";
  console.log(
    `${project}: live in ${Math.round((Date.now() - started) / 1000)}s, ${deployment.git_branch ?? "?"}@${sha.slice(0, 7)}`,
  );
  if (expectedSha && sha !== expectedSha) {
    console.log(
      `::warning::${project} built ${sha.slice(0, 7)}, not ${expectedSha.slice(0, 7)} (a newer push on the branch)`,
    );
  }
}

const projects = process.argv.slice(2);
if (projects.length === 0) throw new Error("usage: node deploy/tose/deploy.ts <project>...");
// In order: the app applies migrations on start, so it goes before the worker.
for (const project of projects) await deploy(project);
