# Asset catalog and lineage

Open when finding an asset by ID or shot, checking what a changed reference invalidates, pinning takes, or
planning cleanup. Code: `scripts/studio/asset_registry_catalog.py`; schema:
`assets/schemas/asset-record.v1.schema.json`.

## Decision (ADR, 2026-10-26)

- **One append-only file**, `<series>/catalog/assets.jsonl`. Lines are `add`, `pin` or `unpin`; none is ever
  rewritten. A path whose bytes change gets a new record that `supersedes` the old one, so a hash a mix
  event or a chain proposal recorded always resolves.
- **Media never move.** The catalog points at files where the pipeline already writes them (`bible/`,
  `gen/`, `audio/`, `renders/`, `upscaled/`, `scenes/`). The logical layout is a view, not a migration.
  `scan` skips `work/` (scratch) except files a scene EDL shows (`src`, `src_raw`, `img`, `pick`, resolved as
  `observe` resolves them): those get role `edl-work`, so a cut never points at an uncatalogued file.
  They are warm by default (as the bible, `vo` and `music` roles are), so `replicate` copies them off-disk.
  A series whose `catalog/policy.json` already exists keeps its own `tiers` (they replace the defaults), so
  add `edl-work` to its warm role rule by hand. Paths take the on-disk letter case, so `Work/Comp.mp4` and
  `work/comp.mp4` are one record on Windows. When no EDL shows such a file any more, `scan` appends a
  `retire` line: the record reads as `rejected` (ephemeral), `check` and `restore` skip it, and a newer take
  at that path is left alone. An EDL that shows it again makes `scan` append `revive`. While any `edl.json` fails to load, `scan`
  retires nothing and lists it in `unreadable_edls`.
- **IDs**: `ast_` + the first 16 hex of sha256(`<content sha256>:<path>`), with `-rN` on a collision.
  Shot identity stays `epNN/scNN/sNN` from the EDL; the catalog never becomes a second EDL or continuity
  store.
- **Lineage from gen-plan.json**: a job's `refs_used`, `first`, `last` and `input` are the parents of its
  `out`; job `status`, `approved`, `model` and `pred_id` give status and source.
- **Cleanup quarantines before it purges.** `gc --dry-run` lists the candidates and why each is held;
  `gc --quarantine` only moves files into `catalog/quarantine/<stamp>/`, and only `gc --purge` deletes, a batch at
  a time, once it is older than the retention (see "GC: quarantine before purge").

Rejected: a SQLite store (binary diffs, harder merges in git), moving media into a new tree (breaks every
existing path and backup), hashing video takes as reproducible (generation is not deterministic; a take's
identity is its bytes plus its request id).

## Commands

```bash
python3 scripts/anime-studio.py assets scan <series> [--rehash]            # idempotent; supersedes changed files
python3 scripts/anime-studio.py assets list <series> --kind video --episode ep01 [--limit 50 --offset 0] [--json]
python3 scripts/anime-studio.py assets get|resolve <series> <asset-id|path>
python3 scripts/anime-studio.py assets refs <series> ep01/sc02 [--shot s06]
python3 scripts/anime-studio.py assets lineage|impact <series> <asset-id>  # parents / everything downstream
python3 scripts/anime-studio.py assets check <series> [--rehash]           # missing or changed files
python3 scripts/anime-studio.py assets pin|unpin <series> <asset-id> --by duy --reason "cut 2 used it"
python3 scripts/anime-studio.py assets gc <series> --dry-run               # candidates and why each is held
python3 scripts/anime-studio.py assets gc <series> --quarantine [--by duy --reason "..."]
python3 scripts/anime-studio.py assets gc <series> --restore <stamp>       # a batch back, byte-identical
python3 scripts/anime-studio.py assets gc <series> --purge [--older-than 7] [--dry-run]
python3 scripts/anime-studio.py assets export-check <series> <asset-id|path|render> [--json]  # exit 1 on a gap
```

Output is paged (`--limit`, `--offset`, `next_offset`), so an agent never lists the whole media tree.

## Storage tiers and remote copies

Code: `scripts/studio/storage_policy_and_replication.py`. Off until `<series>/catalog/policy.json` exists.

```bash
python3 scripts/anime-studio.py assets policy <series> --init --remote-root "G:/My Drive/anime-studio/<series>"
python3 scripts/anime-studio.py assets policy <series>                     # tier counts and GB
python3 scripts/anime-studio.py assets replicate <series> [--remote drive] [--dry-run]
python3 scripts/anime-studio.py assets verify-remote <series> [--deep] [--json]   # exit 1 when degraded
python3 scripts/anime-studio.py assets restore <series> [<asset-id|path>] [--dry-run]
```

- **Tiers**: `hot` stays local only, `warm` is local plus a verified remote copy, `cold` needs a remote copy
  before the local file may go, and `ephemeral` is rebuildable and never copied. The first rule in `tiers`
  whose fields all match a record decides its tier. By default `approved` assets and the bible roles
  (`identity`, `environment`, `style`) plus `vo`, `music` and `edl-work` are warm, `rejected` assets are ephemeral, and
  the rest are hot.
- **Remotes** of kind `fs` are folders: a Google Drive or other sync-client mirror, a NAS share, or an
  external disk. Copies are content-addressed (`objects/<sha[:2]>/<sha256>`). A copy is written
  through a `.part` file and renamed only once it hashes to the record's sha256. Each copy appends a
  receipt to `catalog/replicas.jsonl`. A copy that is already there with the right hash but has no
  receipt is adopted, not uploaded again. Copies have no file extension, so every path that holds the same
  bytes, whatever its suffix, finds the same copy.
- **Degraded**: `verify-remote` reports `unreplicated`, `missing`, `mismatch` (size, or hash with `--deep`)
  and `unreachable` (the remote folder is gone, for example a drive that is not mounted). Any of these
  makes the status degraded.
- **Restore** brings back each replicated live asset whose local file is missing. The copy comes from a
  remote copy that hashes right, located by its receipt, and then `check` runs. A local file whose bytes
  differ from its record may be newer work that has not been scanned yet. Restore reports it as `changed`
  and leaves it alone. `--force` moves it to `<name>.pre-restore.<time><ext>` and then restores the copy.
  If that copy fails or does not hash right, the local file is put back where it was.
- Hot files are not copied by the policy. Without a target, restore lists a missing hot file in
  `not_replicated` and an edited hot file in `hot_changed`; neither fails the run. With a target, only the
  targeted assets decide `ok`.
- A corrupt remote copy is never written into the series. The exit code is 0 only when `ok` is true.
- **Disk preflight**: with a policy, `generate-media-via-multix.py` refuses to start new jobs when free
  space would drop below `reserve_gb` (default 20). A dry run and `--fetch` (jobs already paid for) are not
  held back.
- **Appends** to `assets.jsonl` take `catalog/assets.jsonl.lock` and check the revision they read (the byte
  length of the complete lines). A `scan` or `pin` that raced another append fails with `CatalogChanged`,
  and its rerun is cheap because the hash cache is kept. A last line cut short by a crash is skipped when
  read, and the next append moves it to `catalog/assets.torn.<time>.<pid>.jsonl`. `replicas.jsonl` uses the same
  locked, torn-safe append. A bad line in the middle
  stops the read; it is never skipped.

Restore drill (2026-10-27, on a copy of the frontier `bible/` and `reference/`: 119 files, 365 MB):

- `replicate` copied 110 objects (139 MB) in 1.0 s; a second run skipped them all in 0.01 s.
- `verify-remote --deep` took 0.13 s.
- The test then deleted 15 files and corrupted 2. `restore` brought back the 10 deleted bible files in
  0.17 s. It held the 2 corrupted ones as `changed`; `--force` restored them, byte-identical, after setting
  the damaged copies aside.
- The 5 hot reference files were reported as `not_replicated`.
- An unmounted remote made `verify-remote` report degraded, and `restore` copied nothing.

Before this change the same loss had no copy to come back from. Report:
`plans/reports/asset-storage-261027-restore-drill.md`. On the real frontier catalog the default policy
makes 2,890 records warm: 0.91 GB, or 0.58 GB once the 1,810 unique hashes are counted. The 73.7 GB of
clips stay hot until takes are marked approved.
`scan` and `check` hash only files whose size or mtime moved since `catalog/hash-cache.json` (a cache, not
part of the log; a file modified in the last 2 s is never cached); `scan` prints `hashed`, `check` prints
it on stderr. `--rehash` reads every file for a full verify, for example after copying the series between
disks. On 300 files of 8 MB a warm scan took 0.02 s against 3.7 s cold.
`impact` of an approved character sheet lists the keyframes and clips made from it; redoing them is a plan
for the user, never an automatic rewrite.

### GC: quarantine before purge

Code: `gc_plan`, `quarantine`, `restore_batch` and `purge` in `scripts/studio/storage_policy_and_replication.py`.

- **Candidates** start from the catalog: rejected or superseded records with no child and no pin. `gc` moves one
  only when every rule below lets it through; otherwise `--dry-run` prints the first rule that holds it.
  - It is a derivative: a job made it (`source.job`). Imports, the bible (`identity`, `environment`, `style`),
    renders, and anything under `bible/`, `reference/` or `renders/` are never moved.
  - Its job is still in the gen-plan, still `rejected` and not approved. A job queued again for a retake holds it.
  - Nothing names it: no EDL shot, no mix event, no gen-plan input, no scene page or script. If any EDL, JSON file or
    folder under `episodes/` cannot be read or listed, every candidate is held and `gc` exits 1, because that file
    might name one.
  - No job holds it. A `submitted` job holds its `out` and inputs, and so does a job with a `lease` that has no
    `until` or an `until` still in the future, and so does a job a runner holds a live admission lease for (see
    Admission leases below). Runners record the series and the output they were asked to write (before a `-N`
    suffix) in the lease. A lease for another series holds nothing here; one naming this series' output holds that
    job in any episode, since a ComfyUI run may know no episode; otherwise episode plus job id (or the output file
    name the ComfyUI runner uses as its job) match. A gen-plan that cannot be read stops gc.
  - Its policy tier is not `warm` or `cold`, and it is older than `retention.<tier>_days` (default
    `ephemeral_days: 14`), counted from the record's `seen`. A tier with no age in `retention` is held. A partial
    `retention` in `policy.json` keeps the default ages for the keys it leaves out. Without `catalog/policy.json`
    the default policy applies.
  - A superseded record is left alone: its path holds newer bytes, so only the record remains.
- **Quarantine** re-reads each file and skips one whose bytes moved since the scan. It works out the plan again
  just before moving, so a reference or lease taken while it hashed still holds the file. It writes
  `catalog/quarantine/<stamp>/manifest.json` before moving anything. Each file is then renamed to
  `<stamp>/<its series path>`, and the catalog gets one `quarantine` line per file. `check`, `list`, `restore` and `observe`
  then skip that record, and `scan` never walks `catalog/`. If the catalog append fails (another process appended:
  `CatalogChanged`), every file is moved back. A file whose path was taken again in the meantime stays in the
  batch, and the batch is kept; a move never overwrites a file.
- **`--restore <stamp>`** moves each file back once its bytes still hash to the manifest and nothing has taken
  its path, then writes `unquarantine` lines. A file that fails either test stays in the batch and is listed. The
  batch folder goes once it is empty.
- **`--purge`** deletes from batches whose manifest `at` is at least `--older-than` days old (a finite number;
  default `retention.quarantine_days`, 7). It deletes a manifest item only when all of these hold:
  - its path is a plain relative path inside the batch;
  - its catalog record is quarantined in that batch and not pinned;
  - the manifest's sha256 equals the record's, and the file's bytes still hash to it.
  An item that cannot be read is skipped and the run goes on. An item the catalog already records as purged from
  that batch, with no file left, is taken off the manifest, so a rerun finishes an interrupted purge.
  Any other item stays and is listed under `skipped`, and the exit code is 1. It writes `purge` lines for exactly
  the files it deleted, even when a later deletion fails. A folder without a readable manifest, or one whose items
  the catalog does not record, is listed under `orphans` and left alone. `--purge --dry-run` lists what would go.

Measured on frontier (read-only, 2026-10-27): `gc --dry-run` found 0 candidates (0 MB) before and after this
change. All 8,102 records are `candidate` (none rejected or superseded), so there was nothing to move. The dry run
now takes about 11 s instead of 0.2 s, because it reads every episode JSON for references. It also exits 1: one
file, `episodes/ep01/work/cut2-pipeline/sc04-edl-corrupt.json`, does not parse, so every candidate would be held.

### Licence, provenance and consent gate

```bash
python3 scripts/anime-studio.py assets export-check <series> episodes/ep01/renders/ep01-master.mp4
```

`export_check` walks everything an export is made from:

- the target and its catalog parents;
- for a file under `episodes/<ep>/renders/`, catalogued or not:
  - the scene EDL shots and dialogue VO, from `edl.json` and every dubbed `edl.<lang>.json`;
  - the media any `*.html` or `*.js` under the scene folder names (`index.html`, `src/scene/*.js`, `dist/film.js`;
    `node_modules` and dot folders are skipped, and a linked folder is walked once). A name has its `%` escapes
    decoded and its `?query` and `#fragment` dropped, then is read from the page's folder, each `dir:` folder the
    page sets (the scene config's layers are bare names under `dir: "assets/set"`), the scene folder, the episode
    and the series; every one of those that has the file is walked, since two sets may reuse a layer name (gc
    holds every one as well). A name no file answers fails the gate (a file deleted since
    the render, a template literal such as `` `cels/${n}.png` ``), and so does a `dir:` whose value is not one whole
    string literal (`"assets/" + "set"`, `"assets".concat(x)`, `` `assets/${x}` ``; a vector `dir: [x, y]` is not a folder). Only the engine's own `.depth.png` suffix is let through
    (it is built from a cel's name, which is checked). A scene config's names get no pass: the engine preloads every
    set layer and fails without them, so a name no file answers at gate time is a file moved away after the render.
    A URL is checked by its URL, with `//host/x` read as `https://host/x` and the scheme and host matched in any letter case;
    a `file://` address fails as a file outside the series;
  - the mix events, including each `dub.<lang>` take, and the impulse response of every mix `spaces` entry;
  - a file name that names a scene (`sc03-master.mp4`) narrows this to that scene and the mix events with no
    scene; any other file name uses every scene and the whole mix;
- for a file a job made, the job's inputs as the gen-plan lists them now (an input outside the series fails);
- the same walk again for each of these. A render among the inputs is walked the same way, and it also needs a
  licence entry like an import does, unless a `renders/deliveries.jsonl` row (a render the pipeline
  made) has its path and the sha256 of its current bytes. `finish-scenes.py` and `assemble-episode.py` write that
  hash, and the row's path and the file are compared by their real paths. A row without a hash, or a file
  overwritten since, exempts nothing. A render an older pipeline row still describes is adopted with
  `assets adopt-delivery <series> <file> --by <who> --reason <why>`, which hashes its current bytes into a new row.
  That row must name the same real path with no hash and carry the pipeline's `ts`, `kind`, `tag` and `mib`; the
  file must be within 0.01 MiB of its `mib`, and either no newer than its `ts` or (a copy restored from the Drive
  mirror has a new mtime) hash to a `catalog/replicas.jsonl` receipt or a catalog record from no later than `ts`; the gate names the command only for such a
  file. Any other file under `renders/` (a downloaded clip parked there, a hand-written row, a file overwritten
  since) is refused unless `--force` is passed, and a forced row records `"forced": true`. Only those and the exported render itself are exempt.

A record a job made has its provenance (job, model, request id). Every other file is an import and needs an entry
in `catalog/licences.json`, keyed by path or asset id:
`{"<path>": {"source": "where it came from", "licence": "...", "consent": "...", "by": "duy"}}`.
The entry needs a `source` and a `licence` or a `consent` (a consent covers a person's own face or voice). An
empty value, or `unknown`, counts as missing. Each offender is printed with what it lacks, and the exit code is 1.
A referenced file the catalog does not know is checked by path in the same way. An unreadable `licences.json`
stops the gate. An unreadable EDL (or one whose `shots` is not a list), mix, scene page or gen-plan, a scene folder that cannot be listed, a parent the
catalog does not hold, and a walk that finds no input, fail it. In the DoD checklist, `asset.licence` names this command as its tool.

Measured on frontier (read-only, 2026-10-27): the ep01 cut-2 master has 982 inputs, and 832 of them fail. All
832 lack both provenance and a licence: 334 scene assets (most from the scene pages), 300 sfx, 92 keyframes, 50
others, 36 VO lines and 20 clips. No `licences.json` exists yet, and many files were made outside a gen-plan job.
Earlier versions of the gate walked less. The first found 629 inputs and 478 failures. Adding dialogue VO, dubs
and scene-less mix events brought it to 701 and 551.

### Rebuild plans

```bash
python3 scripts/anime-studio.py rebuild-plan <series> <asset-id|path> [...] [--json]
```

`rebuild-plan` (code: `scripts/studio/rebuild_plan_and_unit_cost.py`) turns `impact` into a task graph.
Each task carries these fields:

| Field | Meaning |
|---|---|
| `inputs` | asset ids it reads |
| `outputs` | the paths it writes |
| `output_assets` | the ids of the records those paths hold now, which the task replaces |
| `resource` | `paid-api`, `gpu-local`, `cpu-render` or `cpu-mux` |
| `lease` | what a runner must hold to start it: `heavy` for `gpu-local`, `provider-<name>` for a paid API, `null` for local CPU work (see Admission leases below) |
| `cost_usd`, `cost_source` | the job's recorded cost, else a price-table estimate, else `null` |
| `est_seconds`, `time_source` | `sidecar` (a ComfyUI clip's `wall_seconds`), `trace` (`gen_submit` to the first `gen_done` that is not `submitted`, for a job that finished in place), `trace-async` (the same span for a job that was submitted and downloaded later, so it includes time nobody fetched: an upper bound), `model-median` (the median of the `sidecar` and `trace` times of the same model and kind in that episode; async spans are left out), or `null` |
| `gates`, `after` | the approval it needs, and the tasks it waits for |

The plan adds `est_seconds_known`, `untimed` (regenerate tasks with no measured time) and `leases` (the
live leases of the series). Render, assemble and remux tasks have no measured time yet. The task actions:

- `regenerate`: for each descendant that a gen-plan job made, one task per path. Its resource is `paid-api`,
  or `gpu-local` for a ComfyUI job, and its gate is `approval`. It runs after its nearest regenerated ancestor.
- `retrim`: for a scene whose EDL `src` was trimmed or upscaled from a regenerated clip (`src_raw`). The
  upscale job runs again after it, as a `regenerate` task with the `approval` gate.
- `render`: only for the scenes whose EDL shows a changed or regenerated file (`src`, `src_raw`, `img` or
  `pick`).
- `assemble`: for each episode that has a re-rendered scene.
- `remux`: for an audio change, including audio regenerated from a changed clip (Foley). The picture is
  reused.

A changed path covers every record ever catalogued there, so a sheet edited and re-scanned still reaches
the keyframes made from its older record. A cost is the job's recorded cost, else the price-table estimate
that `budget` uses (`cost_source: estimate`, shown with `~`), else the task is listed as unpriced, never
guessed. An unreadable `edl.json` is listed and its scene is not planned. The plan only plans: nothing is
submitted, rendered or deleted.

Measured on frontier (read-only, 2026-10-27), comparing before (re-render every scene of the episode)
with the plan (after):

| Change | Before | After |
|---|---|---|
| ep01 keyframe `kf-mv-chatgpt.png` | 12 scenes, 910 s | 2 scenes, 189 s; 1 paid regenerate task, about $0.40 |
| ep01 VO line `ab-s04-pro.wav` | 12 scenes, 910 s | 1 remux, 0 renders |
| sheet `bible/refs/lauren-sheet.png` | 2 scenes, 15 s | 2 scenes, 15 s; 14 paid regenerate tasks, about $3.60 |

Each plan took about 0.2 s. The costs are price-table estimates; no job in these plans has a recorded cost.
With the time fields, the ep01 keyframe plan took 0.3 s. Its one regenerate task needs `provider-atlas` and
has a measured 351 s from the trace.

### Admission leases

Code: `scripts/studio/admission_leases.py`, used by `generate-media-via-multix.py` around every submit and by
`generate-video-via-comfyui.py` around every GPU job.

- A GPU job takes the machine's single `heavy` lease, so only one heavy job runs at a time, whatever series it
  belongs to, and VRAM is never shared. Only the ComfyUI runner takes it, around every run. The media runner
  refuses a job with provider `comfyui` or `local`, or with `resource: gpu-local`, and points at
  `generate-video-via-comfyui.py`; it never submits one.
- The heavy lease lives in `~/.anime-studio/leases/heavy.0.json`, beside the other per-user tool folders
  (`~/.multix`, `~/.codex`). `$ANIME_STUDIO_LEASES` moves it; every runner on the machine must see the same
  folder. A folder that cannot be written stops the runner with that message; it is not reported as busy.
  Provider slots stay per series, in `<series>/catalog/leases/`.
- The ComfyUI runner holds the heavy lease from upload to download. When the lease is busy, it waits
  `--lease-wait` seconds (by default the `--episode`'s `admission.wait_s`, else 600). Then it exits 75 with
  nothing submitted. If the wait for the result times out or fails, it interrupts the prompt and deletes it
  from ComfyUI's queue before it releases the lease, so the next job never shares the GPU with it.
- A provider listed in `episode.json` `admission.providers` takes one of that many slots:
  `{"admission": {"providers": {"atlas": 2, "elevenlabs": 4}, "ttl_s": 3600, "wait_s": 600}}`.
  A provider that is not listed takes no lease. A slot is held only while a job submits (upload and request,
  and the download of a synchronous job). It limits concurrent submits to that provider, not predictions
  still running on the provider after an async submit.
- A lease is the file `<key>.<slot>.json` in one of those folders, created exclusively. It holds the job,
  episode, resource, provider, the owner's pid, process start time and host, a token and `expires_at`.
- A job waits up to `wait_s` for a slot. If none frees, it is held: its status stays as it was and nothing is
  submitted or paid. A media run that held any job exits 75, so a wrapper can run it again later.
- Liveness. On the same host, a lease with a recorded start time is live exactly while that pid runs with
  that start time: a long job is never taken from a live owner, and a reused pid does not keep a dead lease
  alive. `expires_at` decides only a lease from another host, one without a start time, or one whose owner
  runs under an account this one may not inspect (access denied is not death). So `ttl_s` must be longer than
  the longest job in those cases. A lease file that cannot be read, or has no numeric
  `expires_at`, is live for 60 s after it was written, then reclaimable.
- Reclaim and release both unlink a lease under the exclusive lock `<lease>.reclaim`, and only if its token
  is still the one judged dead (or owned). The lease file is never moved aside, so no other process's lease
  is ever missing while it is handled, and an old owner never deletes the lease that replaced its own. The
  lock is hard-linked in already written. It is abandoned after 30 s whoever holds it, and after 2 s if it
  cannot be read.
- Without `admission` config, a cloud job takes no lease, so a single run behaves as before.

```bash
python3 scripts/anime-studio.py leases <series> [--all] [--json]   # the machine's heavy lease and the series' provider slots
python3 scripts/generate-media-via-multix.py $EP --dry-run         # also prints the live leases that would hold jobs
```

## Roadmap

Each step goes behind a flag and needs the user's approval before any paid call or new default provider.

| Workstream | Next step | Blocked on |
|---|---|---|
| D storage | built: policy tiers, `fs` remotes with verified copies, verify/restore, disk preflight, locked appends, GC quarantine/restore/purge (pins, leases, references, retention), licence/provenance/consent `export-check`. Drive drill done on FRONTIER (2026-10-27): 2,041 objects (4.45 GB) replicated to Google Drive for desktop and verified deep, a catalog-only loss drill restored 3,178 files sha256-identical, unreachable and corrupt remotes refused (`plans/reports/asset-storage-261027-drive-restore-drill.md`). Next: `licences.json` entries for frontier's imports, a cold-download check through `gws` | `gws` sign-in by the user |
| E production DAG | built: `rebuild-plan` task graph from `impact` (render only touched scenes, remux for audio, regenerate gated on approval), with input and output asset ids, resource, lease, cost and measured time per task; admission leases (one heavy GPU job per machine across series, taken by the ComfyUI runner, which cancels a prompt it gives up on; the media runner refuses GPU jobs; provider slots per series limit concurrent submits; liveness by pid and process start time, token-checked reclaim under a lock; held runs exit 75; `leases`); `unit-cost` per accepted second with media, token, GPU, storage/egress and people buckets and a `by_engine` split; measured routing: blind A/B ratings (`engines ab-record`, `catalog/engine-ab.jsonl`; a clip is engine, shot and source, rated by majority, cost null when unknown and 0 only for local adapters), `engines measured` ranks engines by A/B cost per accepted second pooled over every A/B, beside the production `by_engine` numbers (fewer than 6 clips: insufficient evidence, not ranked), `engines set-default` writes `<series>/engines.json` only when the A/B that started last, with 6+ clips of each engine and every cost known, shows the new engine cheaper per accepted second (both free: a higher accept rate) at an accept rate no more than 0.1 lower. The gate is fixed; `--force` passes it and is logged as forced. The log row in `catalog/engine-defaults.jsonl` is written before `engines.json`, under one lock. Only runners that read a default follow it; paid video jobs take `model` from gen-plan.json. `recommend()` names the measured best and never changes a default. First billed A/B recorded on FRONTIER (2026-10-27, 12 clips): Atlas H3 6/6 at $0.130 per accepted second, Seedance 2.0 Mini 480p 3/6 at $0.084; the `i2v-cloud` default stays `gemini-omni`, H3 is priced at the measured $0.13/s. Next: an executor that runs a plan, an A/B that includes the current `i2v-cloud` default | billed A/B runs, user approval |
| F knowledge | built: seven lazy-loaded packs with measurable checks, FilmSpec contract and DoD per level (`references/knowledge-packs-and-film-spec.md`). Next: link packs to assets and collections, review tricks (silhouette, contradiction hunt) as evidence templates | content, not code |
| G observability | built: `observe` (time-to-find, resolve rate, duplicates, cache hit, orphans, unknown provenance/licence), `context-bytes` per phase, `dod record/status` (see `report-and-telemetry.md`). Not built yet: context-pack size (cost per accepted second is `unit-cost`). Blind A/B against v1.3.0 done (2026-10-27, three FRONTIER ep03 beats, one rater): main kept 3/3, 47 vs 45 of 60, $8.80 vs $7.41, 0 vs 4 retakes (`plans/reports/ab-261027-blind-v130-vs-main-results.md`). Next: action-beat staging (both arms failed story clarity on the action beat), more raters and beats before reading a size into the lead | more beats and raters |

Measured on the frontier series (2026-10-26, Windows, 16,182 files of which 8,102 media, 105 GB): a cold
`scan` took 86-147 s and wrote a 3.2 MB `assets.jsonl`; `refs`, `lineage`, `impact` and `gc --dry-run` answer
in 0.2-0.3 s. Before the hash cache a cold `scan` or `check` re-hashed every file (166-253 s to add 2-8 new
files, 128 s for `check`); now only new or changed files are read, and `--rehash` is the full verify. A generated file takes its scene and shot from its job,
and a chained clip counts its chain source as a parent, so `refs` lists keyframes and clips and `impact` of
a sheet reaches clips made through a chain. A re-scan refreshes a catalogued file whose job now tells more
(a superseding record with the same bytes and pin; the old record stays out of gc while the path still holds
those bytes). Regenerating a parent never re-points a child that was not regenerated.
