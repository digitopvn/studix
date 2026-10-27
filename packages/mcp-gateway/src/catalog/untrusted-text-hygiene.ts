/**
 * Prompt-injection hygiene for third-party text. Downstream descriptions and results are data: they are
 * bounded, stripped of control characters, and instruction-like sentences in descriptions are removed and
 * flagged. Results are never rewritten (that could corrupt data), only flagged and labelled.
 */

const INSTRUCTION_PATTERNS: RegExp[] = [
  /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules|messages?)/i,
  /\bdisregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|system|earlier)\b/i,
  /\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/i,
  /\byou\s+are\s+now\b/i,
  /\b(?:developer|god|jailbreak|unrestricted|DAN)\s+mode\b/i,
  /<\/?\s*(?:system|assistant|user|instructions?|tool_call)\s*>/i,
  /<\|[a-z_]+\|>/i,
  /\b(?:call|invoke|run|execute|use)\s+(?:the\s+)?(?:tool\s+)?studix_[a-z_]+/i,
  /\breveal\s+(?:your|the)\s+(?:system|secret|hidden|api|instructions?)/i,
  /\b(?:exfiltrate|leak|send|forward)\b[^.]{0,80}\b(?:api[_ -]?keys?|tokens?|secrets?|passwords?|credentials?)\b/i,
  /^\s*(?:IMPORTANT|SYSTEM|ATTENTION|NOTE TO (?:THE )?(?:AI|ASSISTANT|MODEL|AGENT))\s*:/im,
];

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠-⁤﻿]/g;

export const REMOVED_INSTRUCTION_MARKER = "[instruction-like text removed]";

/** True when text contains phrasing aimed at steering an AI agent rather than describing a tool. */
export function looksLikeInstructions(text: string): boolean {
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text));
}

export function stripControlCharacters(text: string): string {
  return text.replace(CONTROL_CHARS, "");
}

/** Truncate to `max` characters, marking the cut. */
export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, max - 1))}…`, truncated: true };
}

export interface SanitizedDescription {
  text: string;
  suspicious: boolean;
  truncated: boolean;
}

/** Remove instruction-like sentences, strip control characters and bound the length. */
export function sanitizeDescription(raw: unknown, maxChars: number): SanitizedDescription {
  const clean = stripControlCharacters(typeof raw === "string" ? raw : "").trim();
  let suspicious = false;
  const kept: string[] = [];
  for (const sentence of clean.split(/(?<=[.!?\n])\s+/)) {
    if (looksLikeInstructions(sentence)) {
      suspicious = true;
      if (kept[kept.length - 1] !== REMOVED_INSTRUCTION_MARKER) kept.push(REMOVED_INSTRUCTION_MARKER);
    } else if (sentence) {
      kept.push(sentence);
    }
  }
  const bounded = truncateText(kept.join(" ").replace(/\s+/g, " ").trim(), maxChars);
  return { text: bounded.text, suspicious, truncated: bounded.truncated };
}

/** First sentence of a sanitized description, bounded for compact search results. */
export function summarize(description: string, maxChars: number): string {
  const first = description.split(/(?<=[.!?])\s+/)[0] ?? "";
  return truncateText(first, maxChars).text;
}
