import type { ExternalSkillRiskFlag } from "@studix/core";

interface Rule {
  flag: ExternalSkillRiskFlag;
  pattern: RegExp;
}

const MAX_SCAN_CHARS = 64_000;

const RULES: readonly Rule[] = [
  { flag: "remote-script-pipe", pattern: /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i },
  {
    flag: "install-command",
    pattern:
      /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b|\bpip3?\s+install\b|\bapt(?:-get)?\s+install\b|\bbrew\s+install\b|\bcargo\s+install\b|\bgo\s+install\b|\bgem\s+install\b/i,
  },
  {
    flag: "script-execution",
    pattern:
      /\b(?:run|execute|invoke|launch)\b[^\n.]{0,60}\b(?:install|setup|bootstrap)\b[^\n.]{0,20}\b(?:script|command)\b|\b(?:bash|sh|python3?|node)\s+(?:\.\/)?scripts\/[\w./-]+|\.\/scripts\/[\w.-]+/i,
  },
  {
    flag: "instruction-override",
    pattern:
      /\bignore\b[^\n.]{0,30}\b(?:previous|prior|above|earlier|all)\b[^\n.]{0,30}\binstructions?\b|\b(?:reveal|print|show|output)\b[^\n.]{0,30}\bsystem prompt\b|\bdisregard\b[^\n.]{0,30}\b(?:instructions?|rules|guidelines)\b|\bnew instructions\s*:/i,
  },
  {
    flag: "credential-request",
    pattern:
      /\b(?:send|paste|provide|enter|share|upload|post|include|reveal)\b[^\n.]{0,50}\b(?:api[ _-]?keys?|access[ _-]?tokens?|secrets?|passwords?|credentials?|private keys?|dotenv)\b/i,
  },
  {
    flag: "destructive-command",
    pattern:
      /\brm\s+-[a-z]*r[a-z]*f?\s+[/~*]|\bmkfs\b|:\(\)\s*\{|\bchmod\s+-R\s+777\b|\bdd\s+if=[^\n]{0,200}\bof=\/dev\//i,
  },
];

/**
 * Heuristic scan of untrusted skill text for instructions an agent should not follow blindly. The result is
 * informational: skill content is data and is never executed, so a flag warns the reader, it does not reject.
 */
export function scanForRisk(texts: readonly string[]): ExternalSkillRiskFlag[] {
  const found = new Set<ExternalSkillRiskFlag>();
  for (const full of texts) {
    // Bounded input keeps the scan linear however large the untrusted text is.
    const text = full.length > MAX_SCAN_CHARS ? full.slice(0, MAX_SCAN_CHARS) : full;
    for (const rule of RULES) if (!found.has(rule.flag) && rule.pattern.test(text)) found.add(rule.flag);
  }
  return [...found];
}
