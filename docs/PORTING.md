# Porting manifest

Studix ports selectively from `motion-mcp` and refactors deliberately. This
manifest records the source, the license obligations and where each source
package went.

Epic [#2](https://github.com/digitopvn/studix/issues/2) adds two more sources,
`zuey-workspace` and `agentkit`; see
[Nguồn zuey-workspace và agentkit](#nguồn-zuey-workspace-và-agentkit).

## Source

| Field         | Value                                                           |
| ------------- | --------------------------------------------------------------- |
| Repository    | [digitopvn/motion-mcp](https://github.com/digitopvn/motion-mcp) |
| Pinned commit | `408ceccd6e2fb5888384e8a4bb7c7385ad1dafda`                      |
| License       | MIT, Copyright (c) 2026 Digitop                                 |

Attribution: code copied or adapted from `motion-mcp` keeps the MIT notice. The
source copyright holder is Digitop, the same owner as Studix. Any file ported
substantially intact should name the source path and SHA in its header comment
so the provenance survives refactors.

## Actions

- **Ported**: logic carried over with renames and rebranding only.
- **Generalized**: the idea and parts of the code kept, reshaped for a
  renderer/provider-neutral, multi-tenant harness.
- **Replaced**: the source implementation is not production-ready for Studix;
  a new implementation fills the same role.
- **Not yet ported**: intentionally left behind for P0.

Status of each row is the state of the P0 target; the code is the evidence once
merged.

## Mapping

| Source (`motion-mcp`)                                       | Studix target                                            | Action         | Notes                                                                                                                                                                                          |
| ----------------------------------------------------------- | -------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo layout, pnpm/TS/Biome/Vitest conventions           | Root tooling, `@studix/*` scope                          | Ported         | `./src/index.ts` exports, `tsx` for apps ([ADR-0001](decisions/0001-monorepo-and-package-boundaries.md))                                                                                       |
| `apps/mcp-server`                                           | `apps/mcp-server`                                        | Generalized    | `motion_*` tools become the smaller `studix_*` surface plus MCP-in-MCP meta-tools; static bearer keys replaced by hashed workspace keys                                                        |
| `apps/dashboard`                                            | `apps/dashboard`                                         | Generalized    | GitHub OAuth sign-in replaced by Better Auth email/password; P0 views only                                                                                                                     |
| `apps/marketing`                                            | `apps/marketing`                                         | Ported         | Skeleton only, rebranded; no design work in P0                                                                                                                                                 |
| (planned `apps/render-worker`)                              | `apps/worker`                                            | Replaced       | Real worker role over the Postgres queue                                                                                                                                                       |
| `packages/shared`                                           | `@studix/shared`                                         | Ported         | Config (env only, Studix hostnames), logger, redaction, ids; error model becomes `StudixError` + `ErrorCode`                                                                                   |
| `packages/motion-ir`                                        | `@studix/video-ir`                                       | Generalized    | `MotionIR`/`CreativeSpec`/`ScenePatch` ideas become `VideoIR`/`Scene`/`Shot`/`Timeline`/`AssetRef`; motion is one specialization ([ADR-0002](decisions/0002-video-ir-and-domain-contracts.md)) |
| `packages/pipeline` (runtime, jobs, build loop)             | `@studix/workflow` + `@studix/core` `StudioService`      | Generalized    | Typed stages and templates; tool schemas move to the MCP app and `video-ir`                                                                                                                    |
| `packages/pipeline` in-process job queue                    | `@studix/workflow` Postgres queue                        | Replaced       | [ADR-0005](decisions/0005-durable-jobs-on-postgres.md)                                                                                                                                         |
| `packages/pipeline` search                                  | deferred `search` package                                | Not yet ported | P1                                                                                                                                                                                             |
| `packages/hyperframes-adapter`                              | `@studix/renderers` (HyperFrames)                        | Ported         | Behind `RendererAdapter` ([ADR-0010](decisions/0010-renderer-and-media-provider-adapters.md))                                                                                                  |
| `packages/media` FFmpeg                                     | `@studix/renderers` (FFmpeg finishing)                   | Ported         |                                                                                                                                                                                                |
| `packages/media` multix runner, capability matrix, registry | `@studix/providers`                                      | Generalized    | `MediaProvider` contract, Multix adapter (Sume, Atlas Cloud, ElevenLabs, Fish, MiniMax) and a fake covering the same kinds; a kind is advertised only when its key is ready                    |
| `packages/pi-runtime`                                       | `@studix/agent-runtime`                                  | Generalized    | `AgentRuntime` boundary + fake; worker-pod isolation instead of relying on the path guard                                                                                                      |
| `packages/jev-router` + `packages/llm`                      | `@studix/decision-routing`                               | Generalized    | `DecisionRouter` + `DecisionProviderAdapter`; OpenRouter, TypeSafeAI, Rules, Fake adapters ([ADR-0003](decisions/0003-jev-decision-provider-adapter-and-routing-fallback.md))                  |
| `packages/director`                                         | planning via `DecisionRouter("video.plan")` or host spec | Not yet ported | Director prompts and critique loops revisit in P2                                                                                                                                              |
| `packages/domain-pack`                                      | `@studix/skills`                                         | Generalized    | Versioned templates and pack pipelines: brand-intro, marketing-video, motion-graphic (28 aesthetic style profiles); brand-inspired profiles await owner review                                 |
| `packages/billing` ledger                                   | `@studix/billing`                                        | Replaced       | Postgres usage ledger, COGS vs price ([ADR-0008](decisions/0008-billing-usage-ledger.md))                                                                                                      |
| `packages/billing` Polar, credit prices                     | none                                                     | Not yet ported | Pricing undecided                                                                                                                                                                              |
| `packages/database` drizzle schema                          | `@studix/database`                                       | Generalized    | Tenant-scoped repositories, migrations ([ADR-0007](decisions/0007-tenancy-isolation.md))                                                                                                       |
| `packages/database` file repository                         | none                                                     | Replaced       | Postgres is the only system of record                                                                                                                                                          |
| `packages/storage` R2 store                                 | `@studix/storage`                                        | Generalized    | One S3 API adapter for R2, MinIO and others                                                                                                                                                    |
| `packages/storage` local disk store                         | none                                                     | Replaced       | MinIO locally and in CI                                                                                                                                                                        |
| `packages/observability`                                    | `@studix/observability`                                  | Ported         | Span attributes extended to org/workspace/project/job/stage/provider/model                                                                                                                     |
| `packages/shared` sealed-box credentials                    | `secretRef` storage                                      | Not yet ported | Encrypted credential store designed with connectors (P1)                                                                                                                                       |

## Technical debt replaced

| Debt in the source                                              | Why it blocks Studix                                | Studix answer                                                                                                            |
| --------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| File/JSONL single-writer stores for records and ledger          | Cannot run more than one app process; no migrations | PostgreSQL + Drizzle migrations                                                                                          |
| In-process job queue; interrupted jobs marked failed on restart | Pod restarts lose work                              | Postgres queue with lease, heartbeat, recovery                                                                           |
| Pi path guard used as the containment for agent file access     | A path guard is not a process sandbox               | Agent work only in the isolated worker role; no shell; scoped credentials                                                |
| Bearer-only MCP auth with static keys                           | No per-workspace revocation, no OAuth               | Hashed, scoped, revocable workspace keys; OAuth plan ([ADR-0006](decisions/0006-auth-and-oauth-client-compatibility.md)) |
| multix video, voice, music and SFX not wired end to end         | Cannot claim those modalities                       | Wired through the pinned multix CLI with estimates, caps, job resume and probe-before-batch (#41)                        |
| Dashboard partial; search and billing planned/partial           | Reviewers and admins need a working surface         | P0 project/job/trace/connector views; search and billing in later phases                                                 |

## File-level port record

Files carried over from the pinned commit and adapted (paths relative to each repository root):

| Source (`motion-mcp`)                         | Studix file                                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/hyperframes-adapter/src/util.ts`    | `packages/renderers/src/hyperframes/html-utils.ts`                                           |
| `packages/hyperframes-adapter/src/fonts.ts`   | `packages/renderers/src/hyperframes/bundled-fonts.ts`                                        |
| `packages/hyperframes-adapter/src/motion.ts`  | `packages/renderers/src/hyperframes/scene-timeline.ts`                                       |
| `packages/hyperframes-adapter/src/compile.ts` | `packages/renderers/src/hyperframes/compile-composition.ts`, `scene-composition.ts`          |
| `packages/hyperframes-adapter/src/render.ts`  | `packages/renderers/src/hyperframes/producer-render.ts`                                      |
| `packages/media/src/ffmpeg.ts`                | `packages/renderers/src/ffmpeg/ffmpeg-probe.ts` (finishing in `ffmpeg-finish.ts` follows it) |
| `packages/media/src/capability-matrix.ts`     | `packages/providers/src/multix-routes.ts` (replaced by live catalogs and `multix check`)     |
| `packages/storage/src/r2-store.ts`            | `packages/storage/src/s3-storage-adapter.ts` (generalized to any S3 endpoint)                |
| `Dockerfile`                                  | `Dockerfile` (one image, `STUDIX_ROLE=app\|worker`)                                          |

Everything else was written for Studix against the contracts above.

## Branding and hostname rule

Runnable code (apps, packages, Dockerfile, infra, CI) must contain no `motion`
product branding and no `motion.digitop.ai` hostnames. Hostnames come from
`STUDIX_*_URL` configuration. The only allowed mentions of the source project
are attribution and provenance comments, and this documentation. A repository
search for `motion.digitop.ai` outside `docs/` should return nothing; CI may
enforce it.

No secrets, `.env` files or data directories are copied from the source.

## Nguồn zuey-workspace và agentkit

Epic [#2](https://github.com/digitopvn/studix/issues/2) port có chọn lọc skill
`anime-creator` của `zuey-workspace` và 11 skill video/motion của `agentkit` thành các
workflow pack trên engine dùng chung. Phần này ghi quyền dùng, SHA đã pin, attribution và
quy trình sync. Audit từng nguồn nằm ở [porting/source-audit.md](porting/source-audit.md),
bản đồ port ở [porting/migration-matrix.md](porting/migration-matrix.md), quyết định ở
[ADR-0013](decisions/0013-hybrid-port-and-workflow-packs.md).

### Quyền dùng

`zuey-workspace` là repo private không có file LICENSE; `agentkit` là phần mềm
proprietary. Chủ sở hữu của cả hai cho phép Studix dùng code, ghi nguyên văn ngày
2026-10-31 trong [issue #39](https://github.com/digitopvn/studix/issues/39):

> Tôi - Zuey, chủ sở hữu, cho phép Studix dùng code từ zuey-workspace và agentkit

Quyền này không biến hai repo nguồn thành mã nguồn mở. Không phân phối lại nguồn ngoài
Studix, và không mang theo phần của bên thứ ba có license riêng (ví dụ phần MIT trong
`LICENSE.txt` của `ak-motion-video` và `ak-motion-design`) mà không giữ notice của phần đó.

### Nguồn đã pin

| Nguồn                                                                 | Commit đã pin                              | Phạm vi                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [mrgoonie/zuey-workspace](https://github.com/mrgoonie/zuey-workspace) | `10719856e9027c92d61892e523b82dd70fca189b` | `.agents/skills/anime-creator` (v1.6.0)                                                                                                                                                                                                                         |
| [bestagentkits/agentkit](https://github.com/bestagentkits/agentkit)   | `9fe4699777a954987bb859bf839dacab1aff14ec` | `kits/marketing/skills/`: `ak-motion-video`, `ak-filmmaking`, `ak-video`, `ak-creativity`, `ak-motion-design`, `ak-elevenlabs`; `kits/core/skills/`: `ak-hyperframes`, `ak-remotion`; `kits/engineer/skills/`: `ak-media-processing`, `ak-shader`, `ak-threejs` |

Dạng rút gọn dùng trong issue và docs: `zuey-workspace` `10719856`, `agentkit` `9fe46997`.

### Attribution

- File port gần như nguyên vẹn ghi trong comment đầu file: repo nguồn, path tương đối với
  root của repo nguồn và SHA đã pin, ví dụ
  `Ported from zuey-workspace@10719856:.agents/skills/anime-creator/scripts/qa-prescan.py`.
- File chỉ lấy ý tưởng hoặc một phần logic ghi nguồn trong mô tả PR, không cần comment.
- Golden test port từ nguồn ghi nguồn ở đầu file test.
- Bảng file-level port record cho hai nguồn này được thêm vào file này khi file đầu tiên
  được port (từ #41 trở đi).

### File-level port record (zuey-workspace và agentkit)

Path nguồn tương đối với root repo nguồn, tại SHA đã pin; path Studix tương đối với
`packages/skills/src/knowledge/`. Knowledge pack ghi nguồn đầy đủ trong trường `sources` của
chính nó ([KNOWLEDGE_PACKS.md](KNOWLEDGE_PACKS.md)).

| Nguồn                                                                                                                              | Studix file                                                                      | Cách port                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `zuey-workspace` `.agents/skills/anime-creator/knowledge/packs/<id>.json` (bảy pack, AC-37)                                        | `packs/<id>-pack.ts`                                                             | Port gần nguyên; id check đổi theo id pack                                            |
| `zuey-workspace` `.agents/skills/anime-creator/SKILL.md` failure modes, ngưỡng của `scripts/qa-*.py`, `audit-mix-buses.py` (AC-38) | `packs/production-failure-modes-pack.ts`                                         | Chuyển thành check `hard`/`evidence`                                                  |
| `agentkit` `kits/marketing/skills/ak-creativity/` `styles.csv`, `voiceover.csv`, `color-psychology.md` (CR-04)                     | `packs/creative-direction-pack.ts`                                               | Chắt lọc; bỏ cột thương hiệu ví dụ                                                    |
| `agentkit` `kits/marketing/skills/ak-elevenlabs/references/scriptwriting-and-performance-guide.md` (EL-05)                         | `packs/voice-performance-pack.ts`                                                | Chắt lọc, trung lập provider                                                          |
| `agentkit` `kits/marketing/skills/ak-motion-design/` (MD-01, MD-02; MIT, LottieFiles)                                              | `packs/motion-design-pack.ts`                                                    | Chắt lọc; gộp hai bảng easing; giữ notice MIT                                         |
| `agentkit` `kits/marketing/skills/ak-motion-video/references/story-and-shots.md`, `motion-craft.md` (MV-17)                        | `packs/motion-craft-pack.ts`                                                     | Chắt lọc; giữ notice MIT của phần vox-director                                        |
| `agentkit` `kits/core/skills/ak-remotion/rules/` (RM-01)                                                                           | `packs/composition-timing-pack.ts`                                               | Chắt lọc, trung lập renderer                                                          |
| `agentkit` `kits/engineer/skills/ak-shader/references/` trừ built-in reference (SH-01)                                             | `packs/shader-gl-pack.ts`                                                        | Viết lại bằng lời, không chép code listing                                            |
| `agentkit` `kits/engineer/skills/ak-threejs/` CSV API, category, use case, guide 00–18 (TJ-02)                                     | `packs/threejs-pack.ts`                                                          | Chắt lọc; nguồn không nêu phiên bản Three.js                                          |
| `agentkit` `ak-creativity/scripts/core.py`, `ak-threejs/scripts/core.py` BM25 (CR-01, TJ-01)                                       | `knowledge-search.ts`                                                            | Viết lại bằng TypeScript, một engine dùng chung                                       |
| `agentkit` `kits/marketing/skills/ak-creativity/data/creative-reasoning.csv` (CR-05, chủ sở hữu duyệt 2026-10-31)                  | `packs/creative-direction-pack.ts`                                               | Port 30 dòng; nền tảng ghi theo định dạng                                             |
| `agentkit` `kits/marketing/skills/ak-creativity/data/music.csv` (CR-06, chủ sở hữu duyệt 2026-10-31)                               | `packs/creative-direction-pack.ts`                                               | Port một phần: 10 thể loại có cách cấp license rõ                                     |
| `agentkit` `kits/engineer/skills/ak-shader/references/` listing GLSL trừ built-in reference (SH-03)                                | `packs/shader-gl-listings.ts`                                                    | Giữ code như nguồn; notice MIT cho simplex noise và `hsb2rgb`                         |
| `agentkit` `kits/engineer/skills/ak-threejs/data/examples-all.csv` (TJ-03)                                                         | `packs/threejs-examples.ts`                                                      | Port 556 dòng; URL và mô tả suy ra từ file; notice MIT của three.js                   |
| `agentkit` `kits/marketing/skills/ak-motion-video/references/styles/profiles/` 40 profile brand-inspired (MV-14)                   | `packs/signature-motion-styles-data.ts`, `packs/signature-motion-styles-pack.ts` | Alias thương hiệu thay bằng mô tả phong cách; font mang tên công ty thay bằng font mở |

### Port record: tool QA

Path nguồn tương đối với `.agents/skills/anime-creator/scripts/` của `zuey-workspace` tại
`10719856`; path Studix tương đối với `tools/qa/`. Contract và giới hạn ở [QA.md](QA.md).

| Nguồn                                          | Studix file                                                                  | Cách port                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `qa-prescan.py` (AC-27)                        | `src/studix_qa/prescan.py`                                                   | Giữ thuật toán và ngưỡng; ffmpeg bằng argv, input qua grant, output JSON |
| `qa-gate-check.py` (AC-27, AC-29)              | `src/studix_qa/judge_reports.py`                                             | Chỉ gộp report; kết quả là evidence, không chặn                          |
| `audit-mix-buses.py` (AC-28)                   | `src/studix_qa/mix_buses.py`                                                 | Nhận stem có sẵn thay vì tự mix bus; key camelCase                       |
| `studio/delivery_encodes.py` (AC-28)           | `src/studix_qa/loudness.py`                                                  | Chỉ phần đo `ebur128`                                                    |
| `make-depth-maps.py` (AC-30)                   | `src/studix_qa/depth_maps.py`                                                | Model đọc local tại revision pin, extra `depth`                          |
| `tests/test_delivery_and_mix_tools.py` (AC-31) | `tests/test_prescan_and_mix_golden.py`, `tests/test_judge_reports_golden.py` | Golden test, media sinh bằng `lavfi`                                     |

| `qa-shot-boundaries.py` (AC-27) | `src/studix_qa/shot_boundaries.py` | Giữ `join_metrics`, `judge` và ngưỡng; join lấy từ timeline của một bản render thay vì clip theo EDL; bỏ strip và chain still |

Chưa port: `ai-shot-qa.py` (gọi model trả tiền; Studix nhận report của nó qua `judge-reports`),
`estimate-plate-depth.py`. `probe`, `black-frames` và `sync` viết mới trên cùng khung sandbox.

### Port record: film-engine và pack phim

Film-engine port gần nguyên (AC-14) từ `.agents/skills/anime-creator/assets/film-engine/` của
`zuey-workspace` tại `10719856`. Mỗi file ghi nguồn ở comment đầu file và đánh dấu chỗ đổi bằng
`Studix:`. Path Studix tương đối với `packages/`.

| Nguồn                                                                                                               | Studix file                                                                           | Cách port                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `engine/src/` (`boot-film-engine.js`, `core/*`, `edit/*`, `gl/*`)                                                   | `renderers/film-engine/src/`                                                          | Port nguyên; font card khai báo một lần từ font đi kèm renderer (`film-scene-fonts.ts`)                            |
| `scene-template/src/edit-template.html`                                                                             | `renderers/film-engine/edit-template.html`                                            | Port nguyên; GSAP và font nạp từ project, CSP chặn network, slot do `film-scene-project.ts` điền thay `build-edit` |
| `anime-creator` `SKILL.md` (tier, gate G0–G4, failure modes, tier mix) (AC-02, AC-04)                               | `skills/src/narrative-film/anime-pack.ts`, `film-scope.ts`                            | Viết lại thành rule kiểm tra scope và chỉ dẫn agent; G0, G1 là creative gate trên cơ chế approval                  |
| `anime-creator` series bible và prompt compiler (AC-05, AC-12)                                                      | `skills/src/narrative-film/film-prompts.ts`                                           | Viết lại: prompt dựng từ bible (style, cast clause, anchor, margin 8%, negative), không chép prompt nguồn          |
| `agentkit` `kits/marketing/skills/ak-filmmaking/` `SKILL.md`, render class, continuity (FM-04, FM-05, FM-08, FM-10) | `video-ir/src/film-production.ts`, `skills/src/narrative-film/long-form-film-pack.ts` | Schema TS chung cho cả hai pack; rule định tuyến theo render class và chuỗi `continuityFrom` thuộc pack            |
| Cả hai nguồn: storyboard, keyframe, lipsync audio-first                                                             | `skills/src/narrative-film/film-pack.ts`, `film-boards.ts`                            | Một factory dùng chung cho `anime` và `long-form-film`, không nhân đôi primitive                                   |

### Quy trình sync có kiểm soát

1. **Pin SHA.** Studix chỉ port từ commit ghi trong bảng trên. Không port từ nhánh đang
   chạy hay bản copy local chưa commit.
2. **Mỗi lần sync là một PR.** Đổi SHA đã pin là một PR riêng, chỉ chứa việc sync: cập nhật
   bảng trên, cập nhật [migration matrix](porting/migration-matrix.md) và các file port bị
   ảnh hưởng.
3. **Kèm diff nguồn.** Mô tả PR có danh sách file đổi giữa SHA cũ và SHA mới trong phạm vi
   đã pin (`git diff --stat <sha-cũ> <sha-mới> -- <path>`) và tóm tắt thay đổi hành vi. File
   port thay đổi phải chỉ ra đoạn diff nguồn tương ứng.
4. **Chỉ đọc repo nguồn.** Audit và sync chỉ dùng `git ls-tree`, `git show` hoặc
   `git archive` tại SHA; không checkout, không sửa repo nguồn.
5. **Lọc trước khi commit.** Không chép path tuyệt đối của máy, secret, file `.env`, dữ liệu
   chạy, bản ghi benchmark, tên phim, series hay studio có sẵn, hay alias thương hiệu thật.
   Thành phần đánh dấu `human review` trong matrix chỉ được port khi chủ sở hữu duyệt.
