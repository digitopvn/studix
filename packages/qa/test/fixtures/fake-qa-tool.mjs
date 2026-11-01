// Stands in for `python -I -m studix_qa <tool>` in the runner tests: same stdin/stdout contract, scripted behaviour.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tool = process.argv[2];
const request = JSON.parse(readFileSync(0, "utf8"));
const answer = (body, code = 0) => {
  process.stdout.write(JSON.stringify({ tool, ...body }));
  process.exit(code);
};

switch (tool) {
  case "echo":
    answer({
      ok: true,
      result: { request, cwd: process.cwd(), env: process.env, out: process.env.STUDIX_QA_OUT },
    });
    break;
  case "sleep":
    setTimeout(() => answer({ ok: true, result: {} }), 60_000);
    break;
  case "garbage":
    process.stdout.write("not json");
    break;
  case "fail":
    answer({ ok: false, error: { code: "NOT_FOUND", message: "media gone", details: { media: "a" } } }, 1);
    break;
  case "odd-code":
    answer({ ok: false, error: { code: "SOMETHING", message: "odd" } }, 1);
    break;
  case "write":
    writeFileSync(join(process.env.STUDIX_QA_OUT, "a.depth.png"), "png");
    answer({ ok: true, result: { outputs: [{ media: "a", file: "a.depth.png", width: 1, height: 1 }] } });
    break;
  case "huge":
    process.stdout.write("x".repeat(2 * 1024 * 1024));
    break;
  case "probe":
    // A wrong shape for the probe contract.
    answer({ ok: true, result: { durationS: "three" } });
    break;
  case "speech-activity": {
    // The grant named in the request is read back, so a test can see which file the probe measured.
    const file = Object.values(request.media)[0] ?? "";
    const voiced = file.includes("voiced");
    if (file.includes("no-model"))
      answer(
        {
          ok: false,
          error: { code: "UNAVAILABLE", message: "needs silero-vad", details: { extra: "speech" } },
        },
        1,
      );
    answer({
      ok: true,
      result: {
        durationMs: 3000,
        speechMs: file.includes("breath") ? 200 : voiced ? 1400 : 0,
        segments: voiced ? [{ startS: 0.2, endS: 1.6 }] : [],
      },
    });
    break;
  }
  default:
    answer({ ok: false, error: { code: "VALIDATION", message: `unknown tool ${tool}` } }, 1);
}
