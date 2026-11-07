# Production skill standard

This is the canonical contract for production-grade AgentKit skills and the default for
any skill this creator scaffolds. It ships with the creator so authors and the validators
read the same text wherever the skill is installed. Other creator references explain how to
meet a clause; this file says what the clause is. Mechanical checks live in
`scripts/quick_validate.py` and `scripts/standard_validation.py`; every warning they emit
carries one of the rule ids in section 8.

The standard adds no frontmatter requirement beyond the Agent Skills fields. Existing
skills keep loading; drift is reported as warnings until a skill is brought up to date.

## 1. Earn a place in the routing catalog

Every routable skill adds a descriptor to the catalog that competes on every request.
Before scaffolding, classify the missing value and pick the smallest artifact that
delivers it:

| Missing value | Preferred artifact |
|---|---|
| The consumer already does it reliably with existing context | No skill; direct execution |
| A variation of work an existing skill owns | Extend that owner with a mode or recipe |
| Knowledge, schemas, API detail or conventions | Reference or searchable corpus behind an owner |
| A repeated output skeleton | Template or asset |
| A repeated deterministic check or transformation | Script, CLI, validator or schema |
| Stable project-wide guidance | Scoped rule or agent context |
| A distinct reusable task with its own outcome, authority and evidence | New skill |

Infer the answer from the request and the installed catalog; ask only when a material
choice remains open. Record why a separate activation surface is needed, then test that
claim with routing negatives against the adjacent owners.

Consolidate by task contract, not topic. Two capabilities belong together when they
share the same user intent, observable output, authority or side-effect boundary,
evidence contract and reusable resources. Sharing a broad domain is not enough: database
operations, backend implementation and payments are all engineering yet differ in
authority and verification. Keep capabilities with different side effects apart even
when their topics match, such as planning ads versus mutating an ads account.

## 2. The minimal contract

A routable skill can answer each question below. These are content requirements, not
nine literal headings; a short skill may answer several in one paragraph.

1. Which user task does it own?
2. What observable result does it deliver?
3. Which prerequisites or context does it need?
4. Which constraints or authority boundaries materially change execution?
5. When does each reference, script or tool load?
6. What evidence proves completion?
7. Which catalog profile should expose it?
8. Which resources does it depend on?
9. Which legacy names or aliases must keep resolving?

Questions 7 to 9 describe catalog placement; until profiles exist, record them in the
change description rather than the skill body.

## 3. Metadata

- `name` is lowercase kebab-case; kit skills use `ak-<slug>`, matching the `ak-<slug>`
  directory, at most 64 characters.
- `description` states the owned action first, then when to use it, then a not-for case
  when a plausible neighbour exists. `when_to_use` repeats the activation condition in
  catalog form and stays consistent with the description.

### Description length decision

| Limit | Value | Source | Enforcement |
|---|---|---|---|
| `description` hard cap | 1024 characters | Agent Skills specification; Pi warns above it | quick_validate error and kit frontmatter lint |
| `description` plus `when_to_use` | 1536 characters | Claude Code truncates the combined text in its skill listing | `descriptor-length` warning |
| Whole catalog | Runtime budget | Codex caps the skill list near 2% of the context window (8,000 characters when unknown) and shortens descriptions first | Front-load the owned task; measure the catalog snapshot |
| Minimum | None | Brevity alone is not a defect | None |

Earlier creator text that implied other caps is superseded by this table. The runtime
figures are provider behavior: recheck the
[Agent Skills specification](https://agentskills.io/specification),
[Claude Code skills](https://code.claude.com/docs/en/skills) and
[Codex skills](https://developers.openai.com/codex/skills) documentation before changing
them. A longer description is never evidence of better routing; activation is measured.

## 4. Standard sections

The body covers three things, under any heading names that read naturally:

- **Activation boundary:** when to use the skill and what to hand off, naming the owner of
  adjacent work where one exists.
- **Outcome and workflow:** sections that state the outcome, authority, high-value
  constraints and the order only where order protects data or feeds a later step. Name
  known failure modes and red flags when real incidents justify them; generic warnings
  and anti-rationalization lists without evidence are cruft.
- **Definition of done:** the observable evidence and the check that produces it. Report
  partial state and unavailable verification honestly; neither counts as passing.

A tiny router or validator whose whole body is the boundary may opt out with
`<!-- skill-standard-exempt: reason -->` in SKILL.md. The reason is required; the marker
exempts the section check only.

## 5. Progressive disclosure and size

- Keep SKILL.md to the common path: outcome, authority, done criteria, routing to
  resources. 300 lines is the AgentKit authoring threshold for SKILL.md and each
  reference. It is stricter than the 500-line runtime guidance because references,
  templates and tool output share the post-activation budget.
- Keep references one level deep from SKILL.md and load each on evidence that its branch
  applies. Moving text into a reference saves context only when the reference loads
  conditionally.
- Do not claim token savings from line or file counts; compare observed catalog, loaded
  files and tool output.

## 6. Cross-skill references

- An `/ak-<slug>` or `$ak-<slug>` mention names a skill that exists in the kits that ship the referencing
  skill. Core skills reference core skills only; describe child-kit capabilities in prose.
- A deliberate legacy alias keeps its line and carries `skill-reference-allow` so the
  dead-reference check skips it.
- Renamed or merged skills keep a migration path for saved selections; see the catalog
  exposure spec in the AgentKit repository (`docs/specs/skill-catalog-exposure-spec.md`).

## 7. Scripts

When a skill ships executable scripts:

- tests live under `scripts/tests/` (or name why the script is exercised elsewhere);
- SKILL.md, a reference or `compatibility` states the supported operating systems;
- dependencies are declared at the invocation site, as in
  `references/script-dependency-strategy.md`.

## 8. Mechanical gates

| Rule id | Check | Severity |
|---|---|---|
| (frontmatter) | YAML parses; `name` and `description` present and typed; description at most 1024 characters, no angle brackets | Error |
| (resources) | Bundled links resolve inside the skill; no unfinished template marker | Error |
| (capability lint) | Kit prose names portable capabilities, not native tool names | Error |
| `description-trigger` | Description or `when_to_use` states an activation condition | Warning |
| `descriptor-length` | Description plus `when_to_use` at most 1536 characters | Warning |
| `standard-sections` | Activation boundary, section headings and completion evidence present, or an exemption | Warning |
| `dead-skill-reference` | Every `/ak-<slug>` or `$ak-<slug>` mention resolves to a skill somewhere under the kits tree; the core-to-child boundary is enforced by the install-completeness tests | Warning |
| `oversized-file` | SKILL.md and each reference within the 300-line authoring threshold | Warning |
| `script-tests` | Shipped scripts have tests | Warning |
| `script-platform-notes` | Shipped scripts state supported platforms | Warning |
| `directory-name`, `kit-namespace`, `when-to-use` | Directory matches the name; kit skills use `ak-<slug>` and set `when_to_use` | Warning |
| `asset-link`, `leftover-template` | Linked assets exist; no initializer leftovers | Warning |

Run one skill with `uv run scripts/quick_validate.py <skill-dir>`, and a whole tree with
`uv run scripts/skill_standard_report.py <root> [--details]`. The report exits 0 on
warnings so existing skills keep passing; `--strict` fails on errors. Warnings become
errors only after the tree is clean for that rule and the change says so. Heuristic
warnings are review prompts, not deletion orders: fix the skill or record why the rule
does not apply.

## 9. Evidence beyond structure

Structural checks prove shape, not effectiveness. Metadata changes need routing traces
with positives, near-misses and no-skill cases; instruction and script changes need
matched consumer comparisons. `references/testing-and-iteration.md` and
`references/semantic-routing-evaluation.md` own those procedures.
