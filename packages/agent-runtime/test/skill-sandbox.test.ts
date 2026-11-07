import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { testTenant } from "@studix/core/testing";
import { describe, expect, it } from "vitest";
import {
  containerPath,
  createFilesystemSkillBundleSource,
  createPiTaskWorkspaceProvider,
  createSandboxToolDefinitions,
  dockerRunArgs,
  materializeSkillBundles,
  type SandboxDriver,
  type SandboxSession,
  type SkillBundle,
} from "../src/index.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const limits = { cpus: 2, memoryMb: 2048, pids: 256, wallTimeMs: 60_000 };

const bundle = (over: Partial<SkillBundle> = {}): SkillBundle => ({
  name: "motion-video",
  description: "Make motion videos",
  scope: "workspace",
  version: "v1",
  files: [
    {
      path: "SKILL.md",
      content: enc("---\nname: motion-video\ndescription: Make motion videos\n---\nSteps"),
    },
    { path: "scripts/run.sh", content: enc("echo hi"), executable: true },
  ],
  ...over,
});

/** A sandbox that records every call and keeps files in memory, as the container would. */
function fakeSandbox() {
  const files = new Map<string, string>();
  const calls: Array<{ kind: string; argv?: readonly string[]; command?: string; cwd?: string }> = [];
  const session: SandboxSession = {
    id: "studix-sbx-test",
    async exec(command, opts = {}) {
      calls.push({ kind: "exec", command, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
      opts.onData?.(Buffer.from("ran\n"));
      return { exitCode: 0 };
    },
    async run(argv, opts = {}) {
      calls.push({ kind: "run", argv });
      const [cmd, ...rest] = argv;
      if (cmd === "cat" && rest[0] === "--") {
        const body = files.get(rest[1]!);
        if (body === undefined) throw new Error("No such file");
        return Buffer.from(body);
      }
      if (cmd === "sh") files.set(rest[3]!, String(opts.stdin ?? ""));
      if (cmd === "test" && !files.has(rest[1]!) && rest[0] !== "-d") throw new Error("exit code 1");
      if (cmd === "find") return Buffer.from("/work/out/video.mp4\n/work/out/../../etc/passwd\n/tmp/x\n");
      return Buffer.alloc(0);
    },
    async copyOut(containerPath, hostPath) {
      calls.push({ kind: "copyOut", argv: [containerPath, hostPath] });
      await writeFile(hostPath, `copy of ${containerPath}`);
    },
    async close() {
      calls.push({ kind: "close" });
    },
  };
  return { session, files, calls };
}

describe("docker sandbox arguments", () => {
  it("drops every privilege, caps resources and passes env by name only", () => {
    const args = dockerRunArgs(
      { image: "studix-sandbox:local" },
      { env: { ELEVENLABS_API_KEY: "sk-very-secret-value" }, limits, skillsDir: "/host/skills" },
      "studix-sbx-1",
      "/host/work",
    );
    const joined = args.join(" ");
    for (const flag of [
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      "--read-only",
      "--user 1000:1000",
      "--cpus 2",
      "--memory 2048m",
      "--memory-swap 2048m",
      "--pids-limit 256",
      "--label studix.sandbox=1",
      "--network bridge",
      "--volume /host/work:/work:rw",
      "--volume /host/skills:/skills:ro",
      "--env ELEVENLABS_API_KEY",
    ]) {
      expect(joined).toContain(flag);
    }
    expect(joined).not.toContain("sk-very-secret-value");
    expect(args.slice(-3)).toEqual(["studix-sandbox:local", "sleep", "infinity"]);
  });

  it("refuses an env name that could smuggle a flag", () => {
    expect(() =>
      dockerRunArgs({ image: "i" }, { env: { "A=1 --privileged": "x" }, limits }, "n", "/w"),
    ).toThrow(expect.objectContaining({ code: "VALIDATION" }));
  });
});

describe("sandbox tools", () => {
  it("runs bash and file operations inside the container, never on the host", async () => {
    const { session, files, calls } = fakeSandbox();
    const tools = createSandboxToolDefinitions(session, ["bash", "write", "read"]);
    expect(tools.map((t) => t.name)).toEqual(["bash", "write", "read"]);
    const [bash, write, read] = tools;
    const signal = new AbortController().signal;
    // A session hands each tool its context; the tools read the session from it.
    const ctx = { sessionManager: SessionManager.inMemory() } as never;
    // biome-ignore lint/suspicious/noExplicitAny: Pi tool execute signatures are generic.
    const exec = (t: any, args: object) => t.execute("call-1", args, signal, () => {}, ctx);
    await exec(bash, { command: "python3 --version" });
    expect(calls.find((c) => c.kind === "exec")).toMatchObject({
      command: "python3 --version",
      cwd: "/work",
    });
    await exec(write, { path: "notes/a.txt", content: "xin chào" });
    expect(files.get("/work/notes/a.txt")).toBe("xin chào");
    const out = await exec(read, { path: "/work/notes/a.txt" });
    expect(JSON.stringify(out)).toContain("xin chào");
    // A path that climbs out still resolves inside the container's filesystem.
    await exec(write, { path: "../../etc/evil", content: "x" });
    expect(files.has("/etc/evil")).toBe(true);
  });

  it("maps the host scratch dir Pi passes as cwd to /work", () => {
    expect(containerPath("D:\\Temp\\studix-pi-ab12", "D:\\Temp\\studix-pi-ab12")).toBe("/work");
    expect(containerPath("/tmp/studix-pi-ab12/out/a.mp4", "/tmp/studix-pi-ab12")).toBe("/work/out/a.mp4");
    expect(containerPath("/tmp/other", "/tmp/studix-pi-ab12")).toBe("/tmp/other");
  });
});

describe("skill bundles", () => {
  it("writes skills under their name and lets the platform copy win a clash", async () => {
    const root = await mkdtemp(join(tmpdir(), "studix-skills-test-"));
    const mounted = await materializeSkillBundles(
      [bundle(), bundle({ scope: "platform", description: "Platform copy" })],
      root,
    );
    expect(mounted).toHaveLength(1);
    expect(mounted[0]).toMatchObject({ name: "motion-video", description: "Platform copy" });
    expect(await readFile(join(root, "motion-video", "scripts", "run.sh"), "utf8")).toBe("echo hi");
  });

  it("mounts a Windows zip: backslash separators and empty folder entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "studix-skills-test-"));
    const files = [
      ...bundle().files,
      { path: "assets", content: enc("") },
      { path: "assets\\logo.svg", content: enc("<svg/>") },
    ];
    await materializeSkillBundles([bundle({ files })], root);
    expect(await readFile(join(root, "motion-video", "assets", "logo.svg"), "utf8")).toBe("<svg/>");
    await expect(
      materializeSkillBundles(
        [bundle({ files: [...bundle().files, { path: "..\\x", content: enc("x") }] })],
        root,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects unsafe paths and bundles without SKILL.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "studix-skills-test-"));
    await expect(
      materializeSkillBundles(
        [bundle({ files: [...bundle().files, { path: "../x", content: enc("x") }] })],
        root,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      materializeSkillBundles([bundle({ files: [{ path: "README.md", content: enc("x") }] })], root),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("reads local skills from a directory and skips links", async () => {
    const root = await mkdtemp(join(tmpdir(), "studix-skills-fs-"));
    const dir = join(root, "workspace", "motion-video");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: motion-video\ndescription: Local skill\n---\nBody");
    await symlink(join(root, "outside"), join(dir, "link")).catch(() => undefined);
    const [found, ...rest] = await createFilesystemSkillBundleSource(root).listEnabled(testTenant());
    expect(rest).toHaveLength(0);
    expect(found).toMatchObject({ name: "motion-video", description: "Local skill", scope: "workspace" });
    expect(found!.files.map((f) => f.path)).toEqual(["SKILL.md"]);
  });
});

describe("task workspace", () => {
  it("mounts the skills, passes only the task's keys and copies results out flattened", async () => {
    const { session, calls } = fakeSandbox();
    const opened: Array<{ env: Readonly<Record<string, string>>; skillsDir?: string }> = [];
    const driver: SandboxDriver = {
      id: "fake",
      async open(request) {
        opened.push({ env: request.env, ...(request.skillsDir ? { skillsDir: request.skillsDir } : {}) });
        return session;
      },
    };
    const outputDir = await mkdtemp(join(tmpdir(), "studix-out-"));
    const provider = createPiTaskWorkspaceProvider({
      driver,
      skills: { listEnabled: async () => [bundle()] },
      env: async () => ({ ELEVENLABS_API_KEY: "k" }),
      limits,
      outputDir,
    });
    const ws = await provider.open(testTenant(), { taskId: "t1", signal: new AbortController().signal });
    expect(ws.skills).toEqual([
      { name: "motion-video", description: "Make motion videos", location: "/skills/motion-video/SKILL.md" },
    ]);
    expect(opened[0]!.env).toEqual({ ELEVENLABS_API_KEY: "k" });
    const files = await ws.collect();
    expect(files).toEqual([join(outputDir, "video.mp4"), join(outputDir, ".._.._etc_passwd")]);
    await ws.close();
    expect(calls.at(-1)).toEqual({ kind: "close" });
  });
});
