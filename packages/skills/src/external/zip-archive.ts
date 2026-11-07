import { inflateRawSync } from "node:zlib";
import { StudixError } from "@studix/shared";

/** One regular file read from an archive. Paths are normalized, relative and never contain `..`. */
export interface ZipFileEntry {
  path: string;
  bytes: Uint8Array;
  executable: boolean;
}

export interface ZipReadResult {
  files: ZipFileEntry[];
  /** Entries left out on purpose (symbolic links, special files), with the reason. */
  skipped: Array<{ path: string; reason: string }>;
}

export interface ZipReadLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxFileBytes: number;
  /** Bytes of all files together, after decompression. */
  maxTotalBytes: number;
  /** Largest allowed uncompressed/compressed ratio of one entry. */
  maxCompressionRatio: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

function invalid(message: string, details?: Record<string, unknown>): StudixError {
  return new StudixError("VALIDATION", message, {
    ...(details ? { details } : {}),
    suggestedAction: "Upload a standard .zip archive of the skill directory (SKILL.md at its root).",
  });
}

/**
 * Normalize an archive path: forward slashes, no leading `./`. Throws on absolute paths, drive letters,
 * `..` segments and control characters, so nothing can be written outside the skill directory.
 */
export function safeArchivePath(raw: string): string {
  const path = raw.replace(/\\/g, "/");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path))
    throw invalid("The archive contains an absolute path", { path: raw });
  const segments = path.split("/").filter((s) => s !== "" && s !== ".");
  for (const segment of segments) {
    if (segment === "..")
      throw invalid("The archive contains a path that leaves its directory", { path: raw });
    for (const ch of segment) {
      const code = ch.codePointAt(0) ?? 0;
      if (code <= 0x1f || code === 0x7f) throw invalid("The archive contains a path with control characters");
    }
  }
  return segments.join("/");
}

/**
 * Read a zip archive fully in memory with every limit enforced before and during decompression: entry
 * count, declared sizes, compression ratio and actual inflated bytes (zip bombs stop at the limit).
 * Symbolic links and special files are skipped, never followed. Only stored and deflate entries are read.
 */
export function readZipArchive(data: Uint8Array, limits: ZipReadLimits): ZipReadResult {
  if (data.byteLength > limits.maxArchiveBytes) {
    throw invalid(`The archive is larger than ${limits.maxArchiveBytes} bytes`);
  }
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  // The end-of-central-directory record sits in the last 22 + 65535 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw invalid("The file is not a zip archive");
  const entryCount = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || centralOffset === 0xffffffff)
    throw invalid("ZIP64 archives are not supported");
  if (entryCount > limits.maxEntries) {
    throw invalid(`The archive has more than ${limits.maxEntries} entries`, { entries: entryCount });
  }
  if (centralOffset + centralSize > eocd) throw invalid("The archive is damaged");

  const files: ZipFileEntry[] = [];
  const skipped: ZipReadResult["skipped"] = [];
  const seen = new Set<string>();
  let total = 0;
  let pos = centralOffset;
  for (let n = 0; n < entryCount; n++) {
    if (pos + 46 > eocd || buf.readUInt32LE(pos) !== CENTRAL_SIGNATURE)
      throw invalid("The archive is damaged");
    const versionMadeBy = buf.readUInt16LE(pos + 4);
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const externalAttrs = buf.readUInt32LE(pos + 38);
    const localOffset = buf.readUInt32LE(pos + 42);
    const rawName = buf.subarray(pos + 46, pos + 46 + nameLength).toString(flags & 0x800 ? "utf8" : "latin1");
    pos += 46 + nameLength + extraLength + commentLength;

    const madeOnUnix = versionMadeBy >> 8 === 3;
    const mode = madeOnUnix ? externalAttrs >>> 16 : 0;
    const isDir = rawName.endsWith("/") || (mode & S_IFMT) === S_IFDIR || (externalAttrs & 0x10) !== 0;
    const path = safeArchivePath(rawName);
    if (isDir || path === "") continue;
    if ((mode & S_IFMT) === S_IFLNK) {
      skipped.push({ path, reason: "symbolic link; never followed" });
      continue;
    }
    if (mode !== 0 && (mode & S_IFMT) !== 0 && (mode & S_IFMT) !== S_IFREG) {
      skipped.push({ path, reason: "special file; not imported" });
      continue;
    }
    if (flags & 0x1) throw invalid("Encrypted archives are not supported", { path });
    if (method !== 0 && method !== 8)
      throw invalid("The archive uses an unsupported compression method", { path });
    const key = path.toLowerCase();
    if (seen.has(key)) throw invalid("The archive contains the same path twice", { path });
    seen.add(key);
    if (uncompressedSize > limits.maxFileBytes) {
      throw invalid(`A file is larger than ${limits.maxFileBytes} bytes`, { path });
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio) {
      throw invalid("A file is compressed suspiciously well (possible zip bomb)", { path });
    }
    if (total + uncompressedSize > limits.maxTotalBytes) {
      throw invalid(`The skill is larger than ${limits.maxTotalBytes} bytes uncompressed`);
    }

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw invalid("The archive is damaged", { path });
    }
    const dataStart =
      localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > buf.length) throw invalid("The archive is damaged", { path });
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    let bytes: Buffer;
    if (method === 0) {
      bytes = Buffer.from(raw);
    } else {
      try {
        // The declared size may lie; inflation itself stops one byte past it.
        bytes = inflateRawSync(raw, { maxOutputLength: Math.max(uncompressedSize, 1) });
      } catch {
        throw invalid("A file could not be decompressed, or is larger than declared", { path });
      }
    }
    if (bytes.length !== uncompressedSize)
      throw invalid("A file is not the size the archive declares", { path });
    total += bytes.length;
    files.push({ path, bytes: new Uint8Array(bytes), executable: (mode & 0o111) !== 0 });
  }
  return { files, skipped };
}
