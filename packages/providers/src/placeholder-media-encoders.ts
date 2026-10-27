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
