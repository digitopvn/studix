/** Longest text the heuristics read; callers pass already size-bounded content. */
const MAX_SCAN_CHARS = 512 * 1024;

/**
 * Heuristic flags for skill text. Each pattern is linear (no nested quantifiers) so untrusted text cannot
 * cause catastrophic backtracking. Flags are informational labels: they never reject a skill.
 */
const RULES: ReadonlyArray<readonly [label: string, pattern: RegExp]> = [
  ["pipe-to-shell", /\b(?:curl|wget)\b[^\n|]{0,500}\|[ \t]{0,10}(?:sudo[ \t]+)?(?:ba|z)?sh\b/i],
  [
    "install-command",
    /\b(?:(?:npm|pnpm|yarn|pip3?|brew|apt|apt-get|cargo|go|gem)[ \t]+(?:install|add|i)\b|npx[ \t]+[\w@])/i,
  ],
  ["executable-permission", /\bchmod[ \t]+(?:[ugoa]*\+x|[0-7]?[0-7][1357][1357])\b/i],
  ["privilege-escalation", /\bsudo[ \t]+\S/i],
  ["destructive-command", /\brm[ \t]+-(?:rf|fr|r[ \t]+-f|f[ \t]+-r)\b/i],
  [
    "credential-request",
    /\b(?:api[ _-]?keys?|(?:access|auth|bearer|github|secret)[ _-]?tokens?|passwords?|credentials?|secret[ _-]?keys?|private[ _-]?keys?|ssh[ _-]?keys?|id_rsa)\b|~\/\.ssh\b|(?:^|[\s"'`/(])\.env\b/i,
  ],
  [
    "instruction-override",
    /\b(?:ignore[ \t]+(?:all[ \t]+)?(?:the[ \t]+)?previous[ \t]+instructions|disregard[ \t]+(?:the[ \t]+)?system[ \t]+prompt|you[ \t]+are[ \t]+now|system[ \t]+prompt|do[ \t]+not[ \t]+tell[ \t]+the[ \t]+user)\b/i,
  ],
];

/** Return the sorted, de-duplicated warning labels that apply to `text`. */
export function scanSkillWarnings(text: string): string[] {
  const bounded = text.slice(0, MAX_SCAN_CHARS);
  return RULES.filter(([, pattern]) => pattern.test(bounded))
    .map(([label]) => label)
    .sort();
}

export function mergeWarnings(...lists: string[][]): string[] {
  return [...new Set(lists.flat())].sort();
}
