import { randomBytes } from "node:crypto";

/** Crockford base32 (lowercase), the ULID alphabet: no i, l, o, u. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const PREFIX_PATTERN = /^[a-z][a-z0-9]{0,11}$/;
const ID_PATTERN = /^([a-z][a-z0-9]{0,11})_([0-9a-hjkmnp-tv-z]{26})$/;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(ms: number): string {
  let out = "";
  let t = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function randomDigits(): number[] {
  const bytes = randomBytes(RANDOM_LEN);
  return Array.from(bytes, (b) => b % 32);
}

/** Increment a base32 digit array; returns false on overflow. */
function increment(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digits[i]!;
    if (d < 31) {
      digits[i] = d + 1;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

/**
 * Sortable, URL-safe id: `<prefix>_<26-char lowercase ULID>`. Ids from one process are strictly
 * increasing (monotonic within the same millisecond), and lexical order matches creation order.
 */
export function newId(prefix: string, now: number = Date.now()): string {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new TypeError(
      `Invalid id prefix "${prefix}": use 1-12 lowercase alphanumerics starting with a letter`,
    );
  }
  if (now <= lastTime) {
    if (!increment(lastRandom)) {
      lastTime += 1;
      lastRandom = randomDigits();
    }
  } else {
    lastTime = now;
    lastRandom = randomDigits();
  }
  const random = lastRandom.map((d) => ALPHABET[d]).join("");
  return `${prefix}_${encodeTime(lastTime)}${random}`;
}

/** True when `value` is an id produced by newId (optionally with the given prefix). */
export function isId(value: unknown, prefix?: string): value is string {
  if (typeof value !== "string") return false;
  const match = ID_PATTERN.exec(value);
  return match !== null && (prefix === undefined || match[1] === prefix);
}

/** Millisecond timestamp encoded in an id, or undefined when the id is malformed. */
export function idTimestamp(id: string): number | undefined {
  const match = ID_PATTERN.exec(id);
  if (!match) return undefined;
  let ms = 0;
  for (const ch of match[2]!.slice(0, TIME_LEN)) ms = ms * 32 + ALPHABET.indexOf(ch);
  return ms;
}
