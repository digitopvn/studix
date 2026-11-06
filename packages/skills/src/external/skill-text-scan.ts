import type { ExternalSkillSecurityNote } from "@studix/core";

interface Rule {
  kind: ExternalSkillSecurityNote["kind"];
  pattern: RegExp;
}

const RULES: Rule[] = [
  {
    kind: "install-command",
    pattern:
      /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b|\bpip3?\s+install\b|\b(?:apt|apt-get|brew|gem|cargo|go)\s+install\b/i,
  },
  {
    kind: "remote-exec",
    pattern:
      /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b|\bbash\s+<\(|\beval\s*\(|\bInvoke-Expression\b|\biex\b\s*\(/i,
  },
  {
    kind: "credential-request",
    pattern:
      /\b(?:api[_ -]?key|secret|token|password|credentials?|private key|ssh key)\b[^\n]{0,60}\b(?:paste|send|share|provide|enter|upload)\b|\b(?:paste|send|share|provide|enter|upload)\b[^\n]{0,60}\b(?:api[_ -]?key|secret|token|password|credentials?|private key)\b/i,
  },
  {
    kind: "instruction-override",
    pattern:
      /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|messages)\b|\bdisregard\s+(?:the\s+)?(?:system|previous|prior)\b|\breveal\s+(?:your|the)\s+(?:system\s+)?prompt\b|\boverride\s+(?:the\s+)?(?:system|safety)\b/i,
  },
];

const MAX_NOTES_PER_FILE = 10;

/**
 * Flag text that asks the reader to run code, install packages, hand over credentials or drop earlier
 * instructions. Notes are advice for the host agent and the person reviewing the skill; they are never a
 * reason to execute anything, and the text is not changed or filtered.
 */
export function scanSkillText(path: string, text: string): ExternalSkillSecurityNote[] {
  const notes: ExternalSkillSecurityNote[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    for (const rule of RULES) {
      if (!rule.pattern.test(line) || seen.has(rule.kind)) continue;
      seen.add(rule.kind);
      notes.push({ kind: rule.kind, path, excerpt: line.trim().slice(0, 160) });
      if (notes.length >= MAX_NOTES_PER_FILE) return notes;
    }
  }
  return notes;
}
