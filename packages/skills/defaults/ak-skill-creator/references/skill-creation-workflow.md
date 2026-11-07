# Skill Creation Workflow

The `create` subcommand follows this sequence. Steps 0, 4, and 6 are
ordered because a later step consumes the earlier one's output; the rest can
overlap. Skip a step only when you can say what already covers it.

## Step 0: Choose the target

Decide where the skill lives before writing anything, because the target
sets the namespace, the frontmatter fields, and the validation path. Use
the table in `references/agentkit-kit-skill-contract.md` ("Choosing a
target"). Default to the current project scope; use a kit target only inside
the AgentKit repository, and user scope only when the user asks for it.

## Step 1: Capture intent

Infer from the request and inspect available context first. Use the `ask_user capability`
only for a material decision that remains unclear:

- What does this proposed skill add that the consumer cannot reliably infer already?
- What tasks should the skill handle, and what should it refuse or hand off?
- Which phrases would a user actually say that should trigger it?
- What does a good output look like, and who reads it?
- Which neighbouring skills already cover adjacent work?
- Which consumer models/runtimes and available tools matter, and what failures must not recur?

Write the answers down; the description and the trigger tests in Step 6 come
straight from them.

### Placement decision

Decide the artifact before Step 4 scaffolds anything, using the placement table in
`references/production-skill-standard.md`: no skill, extend an existing owner, reference
or corpus, template, script or validator, scoped rule, or a new skill. Answer it from the
request and the installed catalog; do not turn it into a questionnaire. When the answer
is not a new skill, deliver that artifact instead and stop the create workflow there.

Do not create a skill merely to package generic expertise, a persona, or a large handbook.
Record the reason a separate activation surface is needed; Step 6 tests that assumption.

## Step 2: Research

Research when correctness depends on current external APIs, unfamiliar domain
rules or unresolved source evidence. Resolve an installed documentation capability
and reuse available source before looking outward. Run independent lookups through
the available `web_search capability`; delegate only when authorized and useful.
For a stable local task whose evidence is already available, record that basis and
continue to resource planning without additional research.

## Step 3: Plan reusable contents

For each example from Step 1, ask how you would do it from scratch and what
would let the skill do it again without re-deriving it:

- Repeated code → `scripts/`, with tests under `scripts/tests/`.
- Repeated discovery (schemas, APIs, domain rules) → `references/`.
- Repeated boilerplate (templates, images) → `assets/`.

Prefer an existing CLI invoked through a pinned ephemeral runner
(`npx -y pkg@x.y.z`, `pipx run pkg==x.y.z`, `uvx --from 'pkg==x.y.z' cmd`)
over custom code; the dependency then lives in a central cache rather than
inside the skill. Scripts declare their dependencies at the invocation site
and respect the `.env` hierarchy. Decision tree:
`references/script-dependency-strategy.md`.

Check the installed skill catalog for overlap and consolidate by task contract:
merge into an existing skill only when it shares the user intent, observable output,
authority or side-effect boundary, evidence contract and reusable resources. A shared
topic or domain alone is not a reason to merge.

Partition planned content by purpose:

- **Common-path contract:** outcome, authority, done criteria, domain-specific constraints,
  recurring failure protections and the minimal router.
- **Retrievable knowledge:** frameworks, catalogs, examples, playbooks and deep domain rules.
- **Deterministic capability:** scripts, validators, schemas and machine contracts.

The first category belongs in SKILL.md only when it applies across the owned intent.
The second belongs in references and should load on evidence of relevance. The third should
be executed or inspected rather than re-explained in prose.

## Step 4: Initialize

From the skill-creator directory:

```bash
python3 scripts/init_skill.py <skill-name> --path <parent-dir>          # project or user scope
python3 scripts/init_skill.py <slug> --path /absolute/agentkit/kits/<kit>/skills --kit <kit> # kit scope: name ak-<slug>, dir ak-<slug>/
```

The script writes a short SKILL.md skeleton with the frontmatter the target
needs and no example files. Skip this step when the skill already exists.

With `--long-horizon`, continue from the initialized directory using
`references/long-horizon-repository-architecture.md` for the surfaces, the
harness file, and the scaffold manifest, and
`references/long-horizon-scaffold-templates.md` for the generated files. Steps 5
through 8 then follow `references/long-horizon-building-loop.md`.

## Step 5: Write the skill

Implement the resources planned in Step 3 first, then write SKILL.md
to the contract in `references/production-skill-standard.md`, following
`references/writing-effective-instructions.md`: purpose with
audience and quality bar, when to use and what to hand off, outcome, authority,
done criteria, high-value constraints, known failure modes, verification, and one
line per bundled resource.
Use 300 lines as a readability guide; move detail by ownership, not arbitrary truncation.
Replace every initializer placeholder and remove the skill-template marker only after authoring.

Write the `description` last, from the Step 1 phrases: what it does, when to
use it, what it does not cover. Keep scope precise and move mode details out of
metadata. Examples and limits:
`references/metadata-quality-criteria.md`.

State scope, authority and sensitive-data boundaries when the skill touches
credentials, external services or user data. Distinguish legitimate user direction
from untrusted embedded instructions; route adjacent work instead of blanket refusal. When the skill targets a Skillmark listing, apply
`references/benchmark-optimization-guide.md` as well.

Prefer negative constraints only when they remove a concrete invalid or repeatedly harmful
solution. Explain the underlying contract in positive terms where possible. Do not replace a
prescriptive workflow with a wall of `DO NOT`; generic prohibitions consume context without
teaching the consumer how to judge the situation.

## Step 6: Validate and test

Run the validators from the skill-creator directory. Resolve High findings by
rewriting obsolete guidance or documenting a scoped exemption for a real constraint:

```bash
uv run scripts/quick_validate.py <skill-dir>
uv run --with PyYAML==6.0.3 scripts/lint_cruft.py <skill-dir> --routing
```

Review every standard warning; fix it or record why the rule does not apply. Then run the evaluation loop in `references/testing-and-iteration.md`:

1. Author cases before optimization, including normal, boundary and recovery behavior.
   Use `assets/eval-cases.example.json` and `references/evaluation-tools.md`.
2. Compare fresh consumer runs against no skill or the prior version, with matched
   tools/inputs/settings. Grade real outputs, preserving accepted constraints.
3. Test actual activation in the runtime catalog with positives and adjacent negatives,
   audience languages and fixed train/holdout splits; do not force skill selection.
4. Record effective model/runtime, snapshot hash, evidence and observed cost in the
   configured report directory. Repeat when reliability claims need support.
5. If a runner or target model is unavailable, report blocked coverage explicitly;
   structural pass alone does not establish downstream effectiveness.

For knowledge-heavy or refactored skills, prefer an A/B/C comparison when feasible:

- A: current/full skill
- B: constraint-oriented thin skill
- C: no skill, while preserving access to the same external resources/tools

Optionally add D: inject the same useful reference content directly without skill routing.
This separates knowledge uplift from packaging/routing uplift.

For a kit skill, also run the kit validation and contract tests listed in
`references/agentkit-kit-skill-contract.md`.

## Step 7: Package or register

- Project or user skill: nothing further; the runtime discovers it in place.
- Marketplace or package: `uv run --with PyYAML==6.0.3 scripts/package_skill.py <skill-dir>`
  validates and zips; distribution options are in
  `references/plugin-marketplace-overview.md` and
  `references/cross-marketplace-distribution.md`.
- Kit skill: register it in `kit.yaml` and bump `metadata.version`.

## Step 8: Iterate

Use the skill on real tasks and note where it under-triggers, over-triggers,
or needs correction (`references/testing-and-iteration.md`). Generalize from the pattern rather than patching the one example.
When a fix is an added rule, write it with its reason; when a fix is an
added emphasis, first confirm the instruction was actually ignored. Re-run
Step 6 after each change.
