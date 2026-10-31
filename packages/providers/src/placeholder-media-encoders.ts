import { crc32, deflateSync } from "node:zlib";

/** An 8-bit RGB color. */
export type Rgb = readonly [number, number, number];

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * Encode a diagonal two-color gradient as an 8-bit RGB PNG. Pure and byte-stable for the same input
 * (zlib output is deterministic for a given level), so placeholder assets can be golden-tested.
 */
export function encodeGradientPng(width: number, height: number, from: Rgb, to: Rgb): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  const span = Math.max(1, width + height - 2);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const t = (x + y) / span;
      const px = row + 1 + x * 3;
      for (let c = 0; c < 3; c++) raw[px + c] = Math.round(from[c]! + (to[c]! - from[c]!) * t);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // color type: truecolor RGB
  // compression, filter and interlace methods stay 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export const PLACEHOLDER_SAMPLE_RATE = 22_050;

/**
 * Encode a quiet sine tone as 16-bit mono PCM WAV. Short linear fades at both ends avoid clicks when the
 * placeholder is mixed into a render.
 */
export function encodeToneWav(
  durationMs: number,
  frequencyHz: number,
  sampleRate = PLACEHOLDER_SAMPLE_RATE,
): Buffer {
  const samples = Math.round((durationMs * sampleRate) / 1000);
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  const fade = Math.min(Math.round(sampleRate * 0.01), Math.floor(samples / 2));
  for (let i = 0; i < samples; i++) {
    const envelope = fade === 0 ? 1 : Math.min(1, i / fade, (samples - 1 - i) / fade);
    const value = Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * 0.2 * envelope;
    buf.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return buf;
}

function riffChunk(id: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0, "ascii");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function riffList(type: string, chunks: Buffer[]): Buffer {
  return riffChunk("LIST", Buffer.concat([Buffer.from(type, "ascii"), ...chunks]));
}

/**
 * Encode an uncompressed (24-bit BI_RGB) AVI whose frames slide a two-color gradient over time. AVI keeps
 * the encoder dependency-free and FFmpeg reads it; the bytes are stable for the same input, so placeholder
 * video can be golden-tested like the PNG and WAV placeholders.
 */
export function encodeGradientAvi(
  width: number,
  height: number,
  frames: number,
  fps: number,
  from: Rgb,
  to: Rgb,
): Buffer {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const frameBytes = stride * height;
  const span = Math.max(1, width + height - 2);
  const frameData: Buffer[] = [];
  for (let f = 0; f < frames; f++) {
    const frame = Buffer.alloc(frameBytes);
    const shift = frames > 1 ? f / (frames - 1) : 0;
    for (let y = 0; y < height; y++) {
      const row = (height - 1 - y) * stride; // DIB rows are stored bottom-up
      for (let x = 0; x < width; x++) {
        const t = ((x + y) / span + shift) % 1;
        const px = row + x * 3;
        for (let c = 0; c < 3; c++) frame[px + (2 - c)] = Math.round(from[c]! + (to[c]! - from[c]!) * t); // BGR
      }
    }
    frameData.push(frame);
  }

  const avih = Buffer.alloc(56);
  avih.writeUInt32LE(Math.round(1_000_000 / fps), 0); // microseconds per frame
  avih.writeUInt32LE(frameBytes * fps, 4); // max bytes per second
  avih.writeUInt32LE(0x10, 12); // AVIF_HASINDEX
  avih.writeUInt32LE(frames, 16);
  avih.writeUInt32LE(1, 24); // streams
  avih.writeUInt32LE(frameBytes, 28); // suggested buffer size
  avih.writeUInt32LE(width, 32);
  avih.writeUInt32LE(height, 36);

  const strh = Buffer.alloc(56);
  strh.write("vids", 0, "ascii");
  strh.write("DIB ", 4, "ascii");
  strh.writeUInt32LE(1, 20); // scale
  strh.writeUInt32LE(fps, 24); // rate
  strh.writeUInt32LE(frames, 32); // length
  strh.writeUInt32LE(frameBytes, 36); // suggested buffer size
  strh.writeInt32LE(-1, 40); // quality: default
  strh.writeUInt16LE(width, 52); // rcFrame right
  strh.writeUInt16LE(height, 54); // rcFrame bottom

  const strf = Buffer.alloc(40); // BITMAPINFOHEADER, compression BI_RGB (0)
  strf.writeUInt32LE(40, 0);
  strf.writeInt32LE(width, 4);
  strf.writeInt32LE(height, 8);
  strf.writeUInt16LE(1, 12); // planes
  strf.writeUInt16LE(24, 14); // bits per pixel
  strf.writeUInt32LE(frameBytes, 20);

  const hdrl = riffList("hdrl", [
    riffChunk("avih", avih),
    riffList("strl", [riffChunk("strh", strh), riffChunk("strf", strf)]),
  ]);
  const movi = riffList(
    "movi",
    frameData.map((frame) => riffChunk("00db", frame)),
  );
  const chunkSize = 8 + frameBytes + (frameBytes % 2);
  const idx = Buffer.alloc(16 * frames);
  for (let f = 0; f < frames; f++) {
    idx.write("00db", f * 16, "ascii");
    idx.writeUInt32LE(0x10, f * 16 + 4); // AVIIF_KEYFRAME
    idx.writeUInt32LE(4 + f * chunkSize, f * 16 + 8); // offset from the "movi" fourcc
    idx.writeUInt32LE(frameBytes, f * 16 + 12);
  }
  return riffChunk("RIFF", Buffer.concat([Buffer.from("AVI ", "ascii"), hdrl, movi, riffChunk("idx1", idx)]));
}
