import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SpokenWord } from "@studix/core";
import { requireService, type StageContext } from "@studix/workflow";
import { z } from "zod";

export type { SpokenWord };

/** Largest word-timing file read back; a speech line's timings are a few kilobytes. */
const MAX_WORDS_BYTES = 256 * 1024;
const MAX_WORDS = 2000;

const StoredWords = z
  .array(
    z.object({
      text: z.string().min(1).max(200),
      startMs: z.number().int().min(0),
      endMs: z.number().int().min(0),
    }),
  )
  .max(MAX_WORDS);

/** Where the word timings of a stored speech take are kept: next to the take, so every reuse finds them. */
export const wordsKeyOf = (storageKey: string) => `${storageKey}.words.json`;

/**
 * Keep the word timings the provider reported for a stored take, written beside the take's local file
 * (`filePath`) and uploaded next to its object. Timings are a refinement: a write that fails leaves the take
 * without them (its words are then estimated), it never fails the paid take.
 */
export async function storeWords(
  s: StageContext,
  storageKey: string,
  filePath: string,
  words: readonly SpokenWord[],
): Promise<boolean> {
  const parsed = StoredWords.safeParse(words.slice(0, MAX_WORDS));
  if (!parsed.success || parsed.data.length === 0) return false;
  const file = `${filePath}.words.json`;
  try {
    await writeFile(file, JSON.stringify(parsed.data));
    await requireService(s, "storage").put(
      s.ctx,
      wordsKeyOf(storageKey),
      { filePath: file },
      {
        contentType: "application/json",
      },
    );
    return true;
  } catch (err) {
    if (s.signal.aborted) throw err;
    return false;
  } finally {
    await rm(file, { force: true });
  }
}

/**
 * The word timings kept next to a stored take, fetched into `workDir`; undefined when it has none (or they
 * cannot be read).
 */
export async function readStoredWords(
  s: StageContext,
  storageKey: string,
  workDir: string,
): Promise<SpokenWord[] | undefined> {
  const file = join(workDir, `${basename(storageKey)}.words.json`);
  try {
    const { bytes } = await requireService(s, "storage").download(s.ctx, wordsKeyOf(storageKey), file);
    if (bytes > MAX_WORDS_BYTES) return undefined;
    const parsed = StoredWords.safeParse(JSON.parse(await readFile(file, "utf8")));
    return parsed.success && parsed.data.length > 0 ? parsed.data : undefined;
  } catch (err) {
    if (s.signal.aborted) throw err;
    return undefined;
  } finally {
    await rm(file, { force: true });
  }
}

/**
 * Word timings guessed for a take without reported ones: its words spread over its speech in proportion to
 * their length, each with a short gap after it. Rough, but it keeps a reveal near its word.
 */
export function estimateWords(text: string, speech: { startMs: number; endMs: number }): SpokenWord[] {
  const words = text.normalize("NFC").split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
  const span = speech.endMs - speech.startMs;
  if (words.length === 0 || span <= 0) return [];
  // A word's weight is its letters plus one for the gap after it, so short words still take some time.
  const weights = words.map((w) => w.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let at = speech.startMs;
  return words.map((w, i) => {
    const length = (span * (weights[i] as number)) / total;
    const startMs = Math.round(at);
    at += length;
    const endMs = Math.max(startMs + 1, Math.round(at - length / (w.length + 1)));
    return { text: w.slice(0, 200), startMs, endMs };
  });
}
