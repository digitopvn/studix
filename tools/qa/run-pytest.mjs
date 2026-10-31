// `pnpm test:qa`: sync tools/qa/.venv from uv.lock and run pytest in it. Uses `uv` on PATH (CI's setup-uv), else
// `python -m uv` / `python3 -m uv`. The venv it leaves behind is the interpreter packages/qa tests and dev runs use.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL(".", import.meta.url));
const candidates = [
  ["uv", []],
  ["python", ["-m", "uv"]],
  ["python3", ["-m", "uv"]],
];

const found = candidates.find(
  ([bin, prefix]) =>
    spawnSync(bin, [...prefix, "--version"], { stdio: "ignore", windowsHide: true }).status === 0,
);
if (!found) {
  console.error("uv is required for the QA tools: https://docs.astral.sh/uv/ (or `pip install uv`).");
  process.exit(1);
}
const [bin, prefix] = found;
const result = spawnSync(
  bin,
  [...prefix, "run", "--locked", "--project", project, "pytest", ...process.argv.slice(2)],
  {
    cwd: project,
    stdio: "inherit",
    windowsHide: true,
  },
);
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
