// The default QA image: the speech-activity tool is there but silero-vad is not installed.
import { readFileSync } from "node:fs";

readFileSync(0, "utf8");
process.stdout.write(
  JSON.stringify({
    tool: process.argv[2],
    ok: false,
    error: { code: "UNAVAILABLE", message: "needs silero-vad", details: { extra: "speech" } },
  }),
);
process.exit(1);
