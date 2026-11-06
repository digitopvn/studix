import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createApiKeyService } from "@studix/auth";
import { createTestDatabase, insertTestUser, type TestDatabase } from "@studix/database/testing";
import { newId } from "@studix/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, TEST_SECRET } from "./app-test-harness.ts";

/**
 * Cross-SDK check: the official Python MCP SDK (pinned) talks to the real `src/main.ts` process over
 * Streamable HTTP. Requires `uv` (preferred; fetches Python >= 3.10 and the pinned SDK) and is skipped with a
 * clear message only when uv is not installed.
 */
const MCP_PYTHON_SDK = "mcp==2.3.0";
const SCRIPT = fileURLToPath(new URL("./python/python-sdk-smoke-client.py", import.meta.url));
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const hasUv = spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0;
if (!hasUv) console.warn("[python-sdk-client] skipped: `uv` is not installed (https://docs.astral.sh/uv/)");

async function waitForReady(base: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      if ((await fetch(`${base}/readyz`)).status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("server did not become ready in time");
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(!hasUv)("Python MCP SDK against the app process", () => {
  let db: TestDatabase;
  let server: ChildProcess | undefined;
  let serverLog = "";
  let base = "";
  let apiKey = "";
  let workspaceId = "";

  beforeAll(async () => {
    db = await createTestDatabase();
    const userId = newId("usr");
    await insertTestUser(db, { id: userId, email: `py-${userId}@example.test` });
    const { organization, workspace } = await db.repos.directory.provisionWorkspace({
      organization: { name: "py", slug: `py-${userId.slice(-8)}` },
      workspace: { name: "Main", slug: "main" },
      ownerUserId: userId,
    });
    workspaceId = workspace.id;
    const keys = createApiKeyService({
      directory: db.repos.directory,
      apiKeys: db.repos.apiKeys,
      env: "test",
    });
    apiKey = (
      await keys.create(
        { organizationId: organization.id, workspaceId, actor: { type: "user", id: userId, role: "owner" } },
        { name: "python-sdk" },
      )
    ).secret;

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["--import", "tsx", MAIN], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        LOG_LEVEL: "warn",
        PORT: String(port),
        DATABASE_URL: db.url,
        STUDIX_PUBLIC_URL: base,
        STUDIX_APP_URL: base,
        STUDIX_API_KEY_ENV: "test",
        BETTER_AUTH_SECRET: TEST_SECRET,
        STUDIX_MIGRATE_ON_START: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = (chunk: Buffer) => {
      serverLog = `${serverLog}${chunk.toString()}`.slice(-8000);
    };
    server.stdout?.on("data", capture);
    server.stderr?.on("data", capture);
    try {
      await waitForReady(base, server, 30_000);
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${serverLog}`);
    }
  }, 60_000);

  afterAll(async () => {
    if (server && server.exitCode === null) {
      const exited = new Promise((resolve) => server?.once("exit", resolve));
      server.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (server.exitCode === null) server.kill("SIGKILL");
    }
    await db?.destroy();
  });

  it("initializes, lists the native tools and calls studix_inspect", async () => {
    const result = await run(
      "uv",
      [
        "run",
        "--no-project",
        "--quiet",
        "--python",
        ">=3.10",
        "--with",
        MCP_PYTHON_SDK,
        "python",
        "-I",
        SCRIPT,
      ],
      {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        UV_CACHE_DIR: process.env.UV_CACHE_DIR,
        STUDIX_MCP_URL: `${base}/mcp`,
        STUDIX_API_KEY: apiKey,
      },
    );
    expect(result.stderr, `python stderr:\n${result.stderr}\nserver log:\n${serverLog}`).not.toContain(
      "failed",
    );
    expect(result.code, `python stderr:\n${result.stderr}\nserver log:\n${serverLog}`).toBe(0);
    const summary = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
    expect(summary.workspaceId).toBe(workspaceId);
    expect(summary.tools).toContain("studix_create_video");
    expect(result.stdout).not.toContain(apiKey);
  }, 180_000);
});
