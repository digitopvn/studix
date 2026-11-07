import type {
  ExternalSkillManifest,
  SkillRiskFinding,
  SkillRiskLevel,
  SkillRiskReport,
  SkillRiskRule,
} from "@studix/core";

/** Bump when rules change, so a report shows which scanner judged it. */
export const SKILL_RISK_SCANNER_VERSION = 1;

const MAX_FINDINGS = 100;
const MAX_FINDINGS_PER_FILE = 12;
const EXCERPT_CHARS = 160;
/** Lines this long are read only in part; minified files still get scanned. */
const MAX_LINE_CHARS = 4000;

interface Rule {
  rule: SkillRiskRule;
  severity: SkillRiskLevel;
  pattern: RegExp;
  /** Which files the rule reads: prose (markdown, text) or code (everything else). */
  in: "prose" | "code" | "any";
}

const RULES: Rule[] = [
  {
    rule: "remote-exec",
    severity: "high",
    in: "any",
    pattern:
      /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\b(?:ba)?sh\s+<\(\s*(?:curl|wget)|\b(?:Invoke-Expression|iex)\b\s*[(\s]|\bIEX\s*\(\s*New-Object/i,
  },
  {
    rule: "secret-harvest",
    severity: "high",
    in: "any",
    pattern:
      /JSON\.stringify\(\s*process\.env\s*\)|Object\.(?:keys|entries|values)\(\s*process\.env\s*\)|\bdict\(\s*os\.environ\s*\)|os\.environ\.(?:items|copy)\(\)|\bprintenv\b|\benv\s*(?:\||>)|~\/\.ssh\b|\bid_(?:rsa|ed25519)\b|\.aws\/credentials|\.docker\/config\.json|\.netrc\b|\/proc\/self\/environ|\bsecurity\s+find-generic-password\b/i,
  },
  {
    rule: "credential-request",
    severity: "high",
    in: "prose",
    pattern:
      /\b(?:api[_ -]?key|secret|token|password|credentials?|private key|ssh key)\b[^\n]{0,60}\b(?:paste|send|share|provide|enter|upload|post)\b|\b(?:paste|send|share|provide|enter|upload|post)\b[^\n]{0,60}\b(?:api[_ -]?key|secret|token|password|credentials?|private key)\b/i,
  },
  {
    rule: "prompt-injection",
    severity: "high",
    in: "prose",
    pattern:
      /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier|other)\s+(?:instructions|rules|messages|prompts)\b|\bdisregard\s+(?:the\s+|all\s+)?(?:system|previous|prior|safety)\b|\breveal\s+(?:your|the)\s+(?:system\s+)?prompt\b|\boverride\s+(?:the\s+)?(?:system|safety|developer)\b|\byou\s+are\s+now\s+(?:in\s+)?(?:developer|dan|jailbreak|unrestricted)\b|\bdo\s+not\s+(?:tell|inform|show)\s+the\s+user\b|<\s*\/?\s*(?:system|im_start|im_end)\s*>/i,
  },
  {
    rule: "prompt-injection",
    severity: "medium",
    in: "prose",
    // Text hidden from a human reviewer: zero-width or bidi control characters, or an HTML comment that talks to the model.
    pattern: /[​-‍⁠‪-‮⁦-⁩]|<!--[^>]*\b(?:assistant|ai|model|claude|agent|instruction)s?\b/i,
  },
  {
    rule: "obfuscated-code",
    severity: "medium",
    in: "any",
    pattern:
      /[A-Za-z0-9+/]{200,}={0,2}|(?:\\x[0-9a-fA-F]{2}){16,}|String\.fromCharCode\((?:\s*\d+\s*,){10,}|\bbase64\s+(?:-d|--decode)\b|\b(?:b64decode|atob)\s*\(|Buffer\.from\([^)]{0,200},\s*["']base64["']\)/,
  },
  {
    rule: "dynamic-eval",
    severity: "medium",
    in: "code",
    pattern:
      /\beval\s*\(|\bnew\s+Function\s*\(|\bexec\s*\(\s*(?:compile|base64|b64decode|bytes|__import__)|\b__import__\s*\(|\bvm\.run(?:In(?:New|This)?Context)?\s*\(/,
  },
  {
    rule: "shell-exec",
    severity: "medium",
    in: "code",
    pattern:
      /\bchild_process\b|\b(?:execSync|spawnSync|execFile|execFileSync)\s*\(|\bsubprocess\.(?:run|call|Popen|check_output|check_call)\b|\bos\.(?:system|popen|exec[lv]p?e?)\s*\(|\bBun\.spawn\b|\bDeno\.Command\b|\bshell\s*=\s*True\b/,
  },
  {
    rule: "network-call",
    severity: "low",
    in: "code",
    pattern:
      /\bfetch\s*\(|\brequests\.(?:get|post|put|delete|request)\b|\burllib\.request\b|\bhttpx\.|\baxios\b|\bhttps?\.request\s*\(|\bnew\s+WebSocket\s*\(|\bsocket\.(?:socket|connect)\b|\b(?:curl|wget|nc|ncat)\s+-?\w/,
  },
  {
    rule: "install-command",
    severity: "low",
    in: "any",
    pattern:
      /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b|\bpip3?\s+install\b|\buv\s+pip\s+install\b|\b(?:apt|apt-get|brew|gem|cargo|go)\s+install\b/i,
  },
];

const ORDER: Record<SkillRiskLevel, number> = { low: 0, medium: 1, high: 2 };
const PROSE = /\.(?:md|markdown|mdx|txt|text|rst)$/i;

/** Executable formats a sandbox could run directly: ELF, PE, Mach-O, and a `#!` script without a known extension. */
function nativeExecutable(bytes: Uint8Array): boolean {
  const b = bytes;
  if (b.length < 4) return false;
  if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return true;
  if (b[0] === 0x4d && b[1] === 0x5a) return true;
  const magic = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic);
}

/** A file handed to the scanner: text when it decoded as UTF-8, otherwise its raw bytes. */
export interface ScannableFile {
  path: string;
  text?: string;
  bytes?: Uint8Array;
}

export class SkillRiskScanner {
  private readonly findings: SkillRiskFinding[] = [];
  private dropped = 0;

  private add(finding: SkillRiskFinding): void {
    if (this.findings.length >= MAX_FINDINGS) this.dropped++;
    else this.findings.push(finding);
  }

  file(file: ScannableFile): void {
    if (file.text === undefined) {
      const executable = file.bytes !== undefined && nativeExecutable(file.bytes);
      this.add({
        rule: "binary-file",
        severity: executable ? "high" : "medium",
        path: file.path,
        excerpt: executable
          ? "Native executable; its behaviour cannot be reviewed from source."
          : "Binary file; its content was not reviewed.",
      });
      return;
    }
    const prose = PROSE.test(file.path);
    const rules = RULES.filter((r) => r.in === "any" || r.in === (prose ? "prose" : "code"));
    const seen = new Set<string>();
    let count = 0;
    const lines = file.text.split("\n");
    for (let i = 0; i < lines.length && count < MAX_FINDINGS_PER_FILE; i++) {
      const line = lines[i]!.slice(0, MAX_LINE_CHARS);
      for (const rule of rules) {
        const key = `${rule.rule}:${rule.severity}`;
        if (seen.has(key) || !rule.pattern.test(line)) continue;
        seen.add(key);
        count++;
        this.add({
          rule: rule.rule,
          severity: rule.severity,
          path: file.path,
          line: i + 1,
          excerpt: line.trim().slice(0, EXCERPT_CHARS),
        });
      }
    }
    // Encoded payload fed to an evaluator is the classic dropper: one finding, high.
    if (seen.has("obfuscated-code:medium") && seen.has("dynamic-eval:medium")) {
      this.add({
        rule: "obfuscated-code",
        severity: "high",
        path: file.path,
        excerpt: "Encoded or obfuscated content and dynamic evaluation in the same file.",
      });
    }
  }

  script(path: string): void {
    this.add({
      rule: "script-present",
      severity: "low",
      path,
      excerpt: "Script; it can run in the skill sandbox.",
    });
  }

  symlink(path: string): void {
    this.add({ rule: "symlink", severity: "low", path, excerpt: "Symbolic link; skipped, never followed." });
  }

  report(now: Date): SkillRiskReport {
    const level = this.findings.reduce<SkillRiskLevel>(
      (max, f) => (ORDER[f.severity] > ORDER[max] ? f.severity : max),
      "low",
    );
    const findings = [...this.findings].sort(
      (a, b) => ORDER[b.severity] - ORDER[a.severity] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
    return {
      level,
      findings,
      ...(this.dropped > 0 ? { truncated: this.dropped } : {}),
      scannerVersion: SKILL_RISK_SCANNER_VERSION,
      scannedAt: now,
    };
  }
}

/**
 * Report for a version stored before the scanner existed. Those versions are data only (no scripts or
 * binaries were kept), so their text notes map onto findings directly.
 */
export function legacyRiskReport(manifest: ExternalSkillManifest, scannedAt: Date): SkillRiskReport {
  const map: Record<string, { rule: SkillRiskRule; severity: SkillRiskLevel }> = {
    "install-command": { rule: "install-command", severity: "low" },
    "remote-exec": { rule: "remote-exec", severity: "high" },
    "credential-request": { rule: "credential-request", severity: "high" },
    "instruction-override": { rule: "prompt-injection", severity: "high" },
    "script-present": { rule: "script-present", severity: "low" },
  };
  const findings = manifest.securityNotes.map((n) => ({ ...map[n.kind]!, path: n.path, excerpt: n.excerpt }));
  const level = findings.reduce<SkillRiskLevel>(
    (m, f) => (ORDER[f.severity] > ORDER[m] ? f.severity : m),
    "low",
  );
  return { level, findings, scannerVersion: 0, scannedAt };
}
