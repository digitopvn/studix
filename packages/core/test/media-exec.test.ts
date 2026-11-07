import { describe, expect, it } from "vitest";
import {
  base64DecodedBytes,
  buildMediaExecArgv,
  MEDIA_EXEC_LIMITS,
  mediaExecContentType,
  parseMediaExecRequest,
} from "../src/studio/media-exec.ts";

const transcode = {
  tool: "ffmpeg",
  args: ["-i", "{in:video.mp4}", "-vf", "scale=iw/2:-2", "-c:v", "libx264", "{out:small.mp4}"],
  inputs: { "video.mp4": { assetId: "ast_1" } },
  outputs: [{ name: "small.mp4" }],
};

function reason(raw: unknown): string | undefined {
  try {
    parseMediaExecRequest(raw);
    return undefined;
  } catch (err) {
    const details = (err as { details?: { reason?: string; field?: string } }).details;
    return details?.reason ?? details?.field ?? (err as Error).message;
  }
}

describe("media exec placeholders", () => {
  it("substitutes sandbox paths and whitelists protocols before every input", () => {
    const argv = buildMediaExecArgv(parseMediaExecRequest(transcode));
    expect(argv).toEqual([
      "ffmpeg",
      "-hide_banner",
      "-nostdin",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      "/work/in/video.mp4",
      "-vf",
      "scale=iw/2:-2",
      "-c:v",
      "libx264",
      "/work/out/small.mp4",
    ]);
  });

  it("substitutes placeholders inside filter arguments and for each of several inputs", () => {
    const argv = buildMediaExecArgv(
      parseMediaExecRequest({
        tool: "ffmpeg",
        args: [
          "-i",
          "{in:a.mp4}",
          "-i",
          "{in:b.mp4}",
          "-filter_complex",
          "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a];movie={in:a.mp4}[x]",
          "-map",
          "[v]",
          "-map",
          "[a]",
          "{out:joined.mp4}",
        ],
        inputs: { "a.mp4": { assetId: "a" }, "b.mp4": { url: "https://example.com/b.mp4" } },
        outputs: [{ name: "joined.mp4" }],
      }),
    );
    expect(argv.filter((a) => a === "-protocol_whitelist")).toHaveLength(2);
    expect(argv).toContain("[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a];movie=/work/in/a.mp4[x]");
  });

  it("puts the whitelist once in front of ffprobe arguments and needs no outputs", () => {
    const argv = buildMediaExecArgv(
      parseMediaExecRequest({
        tool: "ffprobe",
        args: ["-v", "error", "-of", "json", "-show_format", "{in:x.mp4}"],
        inputs: { "x.mp4": { base64: "AAAA" } },
      }),
    );
    expect(argv.slice(0, 4)).toEqual(["ffprobe", "-hide_banner", "-protocol_whitelist", "file,pipe"]);
    expect(argv.at(-1)).toBe("/work/in/x.mp4");
  });

  it("refuses undeclared placeholders and declared outputs no argument writes", () => {
    expect(reason({ ...transcode, args: ["-i", "{in:other.mp4}", "{out:small.mp4}"] })).toBe(
      "undeclared_placeholder",
    );
    expect(reason({ ...transcode, outputs: [{ name: "small.mp4" }, { name: "extra.png" }] })).toBe("outputs");
    expect(reason({ ...transcode, outputs: [] })).toBe("outputs");
  });
});

describe("media exec argument and path validation", () => {
  const withArg = (arg: string) => ({
    ...transcode,
    args: [...transcode.args.slice(0, -1), arg, "{out:small.mp4}"],
  });

  it.each([
    ["/etc/passwd", "absolute_path"],
    ["drawtext=fontfile=/usr/share/fonts/a.ttf:text=hi", "absolute_path"],
    ["movie='/etc/hosts'", "absolute_path"],
    ["C:\\Windows\\win.ini", "windows_path"],
    ["\\\\server\\share\\x.mp4", "windows_path"],
    ["~/secret", "home_path"],
    ["../../etc/passwd", "parent_path"],
    ["in/../../x", "parent_path"],
    ["https://169.254.169.254/latest", "url"],
    ["concat:a.mp4|b.mp4", "protocol"],
    ["subfile,,start,0,end,0,,:x", "protocol"],
    ["file:secret.txt", "protocol"],
  ])("refuses %s", (arg, expected) => {
    expect(reason(withArg(arg))).toBe(expected);
  });

  it.each([
    "scale=iw/2:ih/2",
    "fps=1/5",
    "select='eq(n\\,0)'",
    "-ss",
    "00:00:01.500",
    "[0:a]volume=0.5[a]",
    "title=My clip",
  ])("accepts %s", (arg) => {
    expect(reason(withArg(arg))).toBeUndefined();
  });

  it("refuses options that reopen protocols or unsafe concat lists, and line breaks", () => {
    expect(reason(withArg("-protocol_whitelist"))).toBe("refused_option");
    expect(reason(withArg("-safe"))).toBe("refused_option");
    expect(reason(withArg("a\nb"))).toMatch(/line breaks/);
  });

  it("refuses file names with separators or parent segments", () => {
    expect(reason({ ...transcode, inputs: { "../x.mp4": { assetId: "a" } } })).toBe(
      "Invalid media exec request",
    );
    expect(reason({ ...transcode, outputs: [{ name: "a/b.mp4" }] })).toBe("Invalid media exec request");
    expect(reason({ ...transcode, outputs: [{ name: ".hidden" }] })).toBe("Invalid media exec request");
  });

  it("caps inline base64 inputs", () => {
    const big = "A".repeat(Math.ceil((MEDIA_EXEC_LIMITS.base64Bytes * 4) / 3) + 4);
    expect(reason({ ...transcode, inputs: { "video.mp4": { base64: big } } })).toBe("inputs.video.mp4");
    expect(reason({ ...transcode, inputs: { "video.mp4": { base64: "not base64!" } } })).toBe(
      "inputs.video.mp4",
    );
    expect(base64DecodedBytes("AAAA")).toBe(3);
    expect(base64DecodedBytes("AA==")).toBe(1);
  });

  it("infers output content types from the extension", () => {
    expect(mediaExecContentType("a.mp4")).toBe("video/mp4");
    expect(mediaExecContentType("a.mp3")).toBe("audio/mpeg");
    expect(mediaExecContentType("a.bin")).toBe("application/octet-stream");
    expect(mediaExecContentType("a.mp4", "video/x-custom")).toBe("video/x-custom");
  });
});
