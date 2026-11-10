/** U+0000, a high surrogate with no low one after it, or a low surrogate with no high one before it. */
const UNSTORABLE_SOURCE =
  "\\u0000|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]";
const UNSTORABLE = new RegExp(UNSTORABLE_SOURCE);
const UNSTORABLE_ALL = new RegExp(UNSTORABLE_SOURCE, "g");
const REPLACEMENT = String.fromCharCode(0xfffd);

/**
 * Text Postgres can store in text and jsonb. It refuses U+0000 and an unpaired UTF-16 surrogate; agent output
 * carries both (a tool that read a binary file, a result cut in the middle of an emoji). Each becomes U+FFFD,
 * as undecodable bytes already are.
 */
export function storableText(text: string): string {
  return UNSTORABLE.test(text) ? text.replace(UNSTORABLE_ALL, REPLACEMENT) : text;
}

/**
 * `value` with every string, key included, made storable by `storableText`. Plain objects and arrays are
 * copied; anything else (a Date, a Buffer) is kept as it is.
 */
export function storableJson<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return storableText(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype) return v;
    return Object.fromEntries(Object.entries(v).map(([k, inner]) => [storableText(k), walk(inner)]));
  };
  return walk(value) as T;
}
