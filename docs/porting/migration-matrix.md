# Migration matrix: anime-creator và agentkit

Bản đồ port cho epic [#2](https://github.com/digitopvn/studix/issues/2). Mỗi dòng là một
thành phần của 12 nguồn đã audit ở [source-audit.md](source-audit.md), tại SHA ghi trong
[PORTING.md](../PORTING.md#nguồn-zuey-workspace-và-agentkit). Quyết định nền là
[ADR-0013](../decisions/0013-hybrid-port-and-workflow-packs.md): lõi TypeScript, Python
tool trong sandbox worker, thể loại thành pack.

Matrix là trạng thái kế hoạch, không phải bằng chứng đã port. Một PR đổi loại hoặc đích
của một dòng thì sửa dòng đó trong cùng PR.

## Loại

| Loại                   | Nghĩa                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `core`                 | Engine dùng chung, không biết thể loại: contract, stage, đo đạc, dựng, QA                 |
| `pack:anime`           | Chỉ dùng cho anime: series bible, tier, gate G0–G4, FX và kỹ thuật cel                    |
| `pack:marketing-video` | Quảng cáo, social, demo sản phẩm: template, spec nền tảng, recording, caption theo locale |
| `pack:motion-graphic`  | Motion graphic: style profile, chart, text animation                                      |
| `pack:long-form-film`  | Phim dài: kịch bản, beat sheet, stem audio, bảng ngân sách lipsync                        |
| `pack:knowledge`       | Tri thức sáng tạo nạp theo stage: narrative, camera, motion, GL, âm thanh                 |
| `adapter`              | Bọc provider hoặc renderer sau `MediaProvider` / `RendererAdapter`                        |
| `loại bỏ`              | Không port: lỗi thời, gắn với máy hoặc harness nguồn, trùng lặp, hoặc không an toàn       |
| `human review`         | Cần chủ sở hữu quyết: license, quyền, consent, ngưỡng chất lượng, giá, nội dung nhạy cảm  |

Cột **Chung** đánh dấu ★ cho thành phần thuộc primitive chung character, continuity,
storyboard, lipsync (xem [phần cuối](#primitive-chung-character-continuity-storyboard-lipsync)).

## Sub-issue đích

| Sub-issue                                            | Phạm vi                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| [#41](https://github.com/digitopvn/studix/issues/41) | Multix `MediaProvider` thật và các provider media              |
| [#42](https://github.com/digitopvn/studix/issues/42) | Renderer: HyperFrames, FFmpeg finish, audio mix                |
| [#43](https://github.com/digitopvn/studix/issues/43) | Contracts: storyboard, revision scene/shot, `cacheKey`         |
| [#44](https://github.com/digitopvn/studix/issues/44) | QA hard gate: Python tool trong sandbox worker                 |
| [#45](https://github.com/digitopvn/studix/issues/45) | Pack `marketing-video` và `motion-graphic`                     |
| [#46](https://github.com/digitopvn/studix/issues/46) | Agent có cap và host-agent stage handoff                       |
| [#47](https://github.com/digitopvn/studix/issues/47) | Film-engine, pack `anime` và `long-form film`, primitive chung |
| [#48](https://github.com/digitopvn/studix/issues/48) | Knowledge pack                                                 |
| [#49](https://github.com/digitopvn/studix/issues/49) | MCP `workflowTemplate`, feedback, render, dashboard review     |
| [#50](https://github.com/digitopvn/studix/issues/50) | Benchmark và docs                                              |

## anime-creator

| ID    | Thành phần                                                                                | Loại           | Chung | Đích | Ghi chú                                                                                |
| ----- | ----------------------------------------------------------------------------------------- | -------------- | :---: | ---- | -------------------------------------------------------------------------------------- |
| AC-01 | Dispatcher `anime-studio.py`, trạng thái job trả tiền, trace                              | core           |       | #43  | Chỉ lấy logic stage và trạng thái sang `@studix/workflow`; không port script           |
| AC-02 | Gate G0–G4, tier T0–T3, chế độ `--auto`                                                   | pack:anime     |       | #47  | Gate là cấu hình pack trên cơ chế approval của engine                                  |
| AC-03 | Interview và scope lock (luồng hỏi, khóa phạm vi)                                         | core           |       | #46  | Thành stage host-agent handoff; câu hỏi riêng anime nằm trong pack                     |
| AC-04 | Template scope lock, set, QA rubric trong `assets/templates/`                             | pack:anime     |       | #47  | Schema chung vào core, nội dung mẫu vào pack                                           |
| AC-05 | Series bible, `story-so-far.md`                                                           | pack:anime     |       | #47  | Giới hạn độ dài và cách cập nhật theo tập                                              |
| AC-06 | Contract `edl.json` (shot, kind, tier, beat, dialogue, boundary)                          | core           |       | #43  | Map vào `Timeline`/`Shot` của `@studix/video-ir`                                       |
| AC-07 | Danh sách shot rải ở bảng beat, `action-plan.json`, `filmspec.json`                       | core           |   ★   | #43  | Gộp thành một `Storyboard`; nguồn có EDL và filmspec chồng nhau                        |
| AC-08 | Character bible, `reference_roles.py`, `reference_reel_builder.py`                        | core           |   ★   | #47  | Gộp với FM-04                                                                          |
| AC-09 | `continuity.json`, `continuity_transition_validator.py`, `shot_boundary_contract.py`      | core           |   ★   | #47  | Gộp với FM-05; giữ ba chế độ biên shot                                                 |
| AC-10 | Lipsync: `align-vo-to-omni.py`, `gate-tts-takes.py`, `retime-vo-line.py`, `lip_sync_lag`  | core           |   ★   | #47  | Tool đo chạy theo khung sandbox của #44; gộp với FM-07                                 |
| AC-11 | Gate lipsync `within_3_frames`                                                            | human review   |   ★   | #47  | Ngưỡng do chủ sở hữu duyệt                                                             |
| AC-12 | `shot_prompt_compiler.py`                                                                 | core           |       | #47  | Thứ tự input là core; khối style anime vào pack                                        |
| AC-13 | `action_plan_grammar.py`, `impact-fx-presets.json`                                        | pack:anime     |       | #47  |                                                                                        |
| AC-14 | Film-engine GL (multiplane, FX, camera rig, captions)                                     | core           |       | #47  | Port nguyên theo #47                                                                   |
| AC-15 | Template scene HyperFrames của film-engine                                                | adapter        |       | #42  | Sau `RendererAdapter`                                                                  |
| AC-16 | `build-scene.sh` (Bash, `npx -y esbuild`)                                                 | loại bỏ        |       | #47  | Viết lại build đa nền tảng, pin trong lockfile                                         |
| AC-17 | Layout dự án dựa trên file và fetch CDN lúc init                                          | loại bỏ        |       | #47  | Thay bằng storage và asset pin có checksum trong image                                 |
| AC-18 | `generate-media-via-multix.py` (guard, job, ledger)                                       | adapter        |       | #41  | Guard và ledger thành logic của adapter và `@studix/billing`                           |
| AC-19 | Quy tắc ngân sách: trần ở G0, dừng khi khoản ngoài kế hoạch vượt 20%, probe model chưa đo | core           |       | #41  | Probe trước batch, dừng khi lệch 20%: `runMediaBatchWithProbe`; nối stage sau #40      |
| AC-20 | `engines.json` (role → adapter)                                                           | core           |       | #41  | Schema vào core; số đo GPU là dữ liệu cần review                                       |
| AC-21 | Giá trong `price-table.json`                                                              | human review   |       | #41  | Có khuyến mãi hết hạn 2026-11-12; adapter dùng catalog sống                            |
| AC-22 | `telemetry_trace_and_ledger.py` (trace, ledger)                                           | core           |       | #41  | Trace vào observability, ledger vào billing                                            |
| AC-23 | Đọc key từ `~/.multix/.env`                                                               | loại bỏ        |       | #41  | Adapter đặt `MULTIX_DISABLE_HOME_ENV=1`; key qua env worker, chưa qua `secretRef`      |
| AC-24 | `generate-video-via-comfyui.py`, `comfyui-workflows/`                                     | adapter        |       | #41  | Provider local tùy chọn, cần GPU                                                       |
| AC-25 | `make-voice-variants.py`                                                                  | adapter        |       | #41  |                                                                                        |
| AC-26 | `draw-images-via-codex.py` (workspace-write)                                              | human review   |       | #46  | Ranh giới tin cậy của agent ghi file                                                   |
| AC-27 | `qa-prescan.py`, `qa-gate-check.py`, `qa-shot-boundaries.py`                              | core           |       | #44  | Hard gate                                                                              |
| AC-28 | `audit-mix-buses.py`, đo loudness và true peak                                            | core           |       | #44  | Gate -14 LUFS ±1, ≤ -1.5 dBTP                                                          |
| AC-29 | `ai-shot-qa.py`, `qa-prompts.md`                                                          | core           |       | #44  | AI judge chỉ là evidence                                                               |
| AC-30 | `make-depth-maps.py`, `estimate-plate-depth.py`                                           | adapter        |       | #44  | Image worker tùy chọn có torch                                                         |
| AC-31 | `scripts/tests/`                                                                          | core           |       | #44  | Golden test đi cùng tool                                                               |
| AC-32 | `build-audio-mix.py`, `make-space-ir.py`, `mix-shape-features.py`                         | core           |       | #42  |                                                                                        |
| AC-33 | `finish-scenes.py`, `assemble-episode.py`, `upscale-finished-scenes.py`                   | core           |       | #42  |                                                                                        |
| AC-34 | `track-plate-motion.py`, `chroma-key-cutout.py`, `warp-plate-yaw-perspective.py`          | pack:anime     |       | #47  | Kỹ thuật plate cel                                                                     |
| AC-35 | `make-review-tiles.py`                                                                    | core           |       | #49  | Contact sheet cho dashboard review theo shot                                           |
| AC-36 | Duyệt G0 và G1 của người dùng (scope, thiết kế)                                           | human review   |       | #49  | Approval qua MCP và dashboard                                                          |
| AC-37 | Bảy knowledge pack trong `knowledge/`                                                     | pack:knowledge |       | #48  | narrative, performance, art-direction, dop-camera, wardrobe-props, physics-lite, sound |
| AC-38 | Failure mode đã đo trong `SKILL.md`                                                       | core           |       | #48  | Check `hard`/`evidence` trong pack `production-failure-modes`                          |
| AC-39 | `measure-reference-cut.py`                                                                | core           |       | #50  | Đo so với bản cắt tham chiếu khi benchmark                                             |
| AC-40 | `plans/reports/` (bản ghi benchmark)                                                      | loại bỏ        |       | #50  | Chỉ dùng số liệu làm mốc; có tên series mẫu                                            |
| AC-41 | Tên studio và phim có thật trong frontmatter                                              | loại bỏ        |       | #47  | Không chép sang Studix                                                                 |

## ak-filmmaking

| ID    | Thành phần                                                           | Loại                | Chung | Đích | Ghi chú                                                             |
| ----- | -------------------------------------------------------------------- | ------------------- | :---: | ---- | ------------------------------------------------------------------- |
| FM-01 | `schemas/*` và validator `film_schema.py`                            | core                |       | #43  | Chuyển thành schema TS; giữ parse chặt và chặn path không tương đối |
| FM-02 | `film_graph.py` loader                                               | core                |       | #43  |                                                                     |
| FM-03 | `film.py validate`, trạng thái vòng đời shot                         | core                |       | #43  | Enum riêng phim vào pack                                            |
| FM-04 | `character.schema.json`, vòng đời ảnh tham chiếu, `identity_version` | core                |   ★   | #47  | Enum `view` mở rộng cho anime                                       |
| FM-05 | `film_continuity.py`, object `continuity` và `continuity_changes`    | core                |   ★   | #47  | Diff state theo chuỗi kèm thay đổi khai báo                         |
| FM-06 | `shot.json`, still storyboard, điều kiện animatic                    | core                |   ★   | #43  | Contract `Storyboard` chung                                         |
| FM-07 | `audio-cue` và `alignment` schema, enum lipsync, gate audio trước    | core                |   ★   | #47  |                                                                     |
| FM-08 | Bảng ngân sách lipsync (`recommended_dedicated`)                     | pack:long-form-film |   ★   | #47  |                                                                     |
| FM-09 | `film_prompt.py`                                                     | pack:long-form-film |       | #47  | Thứ tự input là core                                                |
| FM-10 | Kịch bản và beat sheet                                               | pack:long-form-film |       | #47  |                                                                     |
| FM-11 | Stem audio DX, FX, AMB, MX và cue schema                             | pack:long-form-film |       | #47  |                                                                     |
| FM-12 | Tier routing và chế độ ngân sách                                     | adapter             |       | #41  | Trung lập provider                                                  |
| FM-13 | Object chi phí (`amount`, `currency`, `source`) và ước tính          | core                |       | #43  |                                                                     |
| FM-14 | Timeline và ffconcat                                                 | core                |       | #42  | Ghép bằng ffmpeg là adapter                                         |
| FM-15 | QC category và bảng quay về stage                                    | core                |       | #44  | Category riêng phim vào pack                                        |
| FM-16 | Gate animatic và promotion                                           | human review        |       | #49  | Người duyệt qua dashboard                                           |
| FM-17 | `tests/test_film_tools.py` (62 test)                                 | core                |       | #47  | Chạy cùng primitive chung                                           |
| FM-18 | Fixture `assets/examples/`                                           | pack:long-form-film |       | #47  |                                                                     |
| FM-19 | `evals/evals.json` (routing skill)                                   | loại bỏ             |       | #50  | Gắn với cách route skill của agentkit                               |

## ak-video

| ID    | Thành phần                                                    | Loại                 | Đích | Ghi chú                                               |
| ----- | ------------------------------------------------------------- | -------------------- | ---- | ----------------------------------------------------- |
| AV-01 | Pipeline `create.md`                                          | pack:marketing-video | #45  | Thêm người duyệt trước khi chi tiền sinh video        |
| AV-02 | `script-create.md`, `script-templates.md`, `templates/*.json` | pack:marketing-video | #45  |                                                       |
| AV-03 | Spec nền tảng (`video-types-specs.md`, `PLATFORM_SPECS`)      | pack:marketing-video | #45  | Hai nguồn mâu thuẫn; kiểm chứng sống trước khi export |
| AV-04 | Storyboard START/END của `create-storyboard.cjs`              | human review         | #43  | Chọn một contract storyboard cùng FM-06               |
| AV-05 | `generate-video.cjs`                                          | adapter              | #41  | Thêm điều kiện frame                                  |
| AV-06 | `veo-prompt-guide.md`, `audio-directive-guide.md`             | adapter              | #41  | Tri thức riêng provider                               |
| AV-07 | `npx -y @mrgoonie/multix` lúc chạy                            | loại bỏ              | #41  | Image worker build multix ở commit `a2507d55`         |
| AV-08 | `extract-captions.cjs` (SRT, VTT)                             | core                 | #42  |                                                       |
| AV-09 | `optimize-for-platform.cjs`                                   | adapter              | #42  | Sửa shell injection: argv, không shell                |
| AV-10 | `analyze-video.cjs`                                           | adapter              | #44  | Kết quả là evidence                                   |
| AV-11 | AI review R1–R6 và ngưỡng 7/8                                 | human review         | #44  | Không tự duyệt bằng model                             |
| AV-12 | Bảng chi phí trong `quality-review-workflow.md`               | loại bỏ              | #45  | Giá nhớ lại                                           |
| AV-13 | `thumbnail-design-guide.md`, `video-seo-optimization.md`      | loại bỏ              | #45  | Ngoài phạm vi sản xuất video                          |

## ak-creativity

| ID    | Thành phần                                                 | Loại                 | Đích | Ghi chú                                 |
| ----- | ---------------------------------------------------------- | -------------------- | ---- | --------------------------------------- |
| CR-01 | `core.py` BM25 trên CSV và `search.py`                     | core                 | #48  | Một search engine dùng chung với TJ-01  |
| CR-02 | `creative_brief.py`                                        | pack:marketing-video | #45  |                                         |
| CR-03 | `platforms.csv`                                            | pack:marketing-video | #45  | Kiểm chứng sống                         |
| CR-04 | `styles.csv`, `voiceover.csv`, `color-psychology.md`       | pack:knowledge       | #48  |                                         |
| CR-05 | `creative-reasoning.csv`                                   | human review         | #48  | Luật quyết định cần chủ sở hữu duyệt    |
| CR-06 | `music.csv`, `audio-music.md`                              | human review         | #48  | License nhạc                            |
| CR-07 | `creative-styles-part1.md`, `part2.md`, `visual-trends.md` | loại bỏ              | #48  | Trùng `styles.csv`; số liệu không nguồn |

## ak-motion-video

| ID    | Thành phần                                                                   | Loại                 | Đích | Ghi chú                                                |
| ----- | ---------------------------------------------------------------------------- | -------------------- | ---- | ------------------------------------------------------ |
| MV-01 | `doctor.py` preflight                                                        | core                 | #42  |                                                        |
| MV-02 | Composition contract, skeleton, `assemble.py`, `tl.py`, `scaffold-scenes.py` | adapter              | #42  | HyperFrames sau `RendererAdapter`                      |
| MV-03 | `build-timeline.mjs` (TIMING, caption, envelope mix)                         | core                 | #42  |                                                        |
| MV-04 | `align-voiceover.mjs`                                                        | core                 | #42  |                                                        |
| MV-05 | `fit-beat-grid.py`, `arrange-music.mjs`, `verify-arrangement.py`             | core                 | #42  |                                                        |
| MV-06 | `reframe.py`                                                                 | core                 | #42  | Chỉ sau khi master được duyệt                          |
| MV-07 | `audit-ratio-scope.py`                                                       | loại bỏ              | #42  | Công cụ dev dựa trên git                               |
| MV-08 | `generate-audio-assets.mjs`                                                  | adapter              | #41  | Không có dry-run hay trần chi; bỏ `shell: true`        |
| MV-09 | Doc generated-art và route ảnh                                               | human review         | #41  | Quyền và chân dung                                     |
| MV-10 | `measure-mix-balance.py`, `probe.py`                                         | core                 | #44  |                                                        |
| MV-11 | `validate.py`, `contact-sheet.py`, `check-bounds.mjs`                        | core                 | #44  |                                                        |
| MV-12 | Style index và `resolve-style.py`                                            | core                 | #45  | Engine chọn style                                      |
| MV-13 | 28 profile thẩm mỹ và 2 profile nội bộ                                       | pack:motion-graphic  | #45  |                                                        |
| MV-14 | 40 profile lấy cảm hứng từ thương hiệu và alias                              | human review         | #45  | Alias nêu tên thương hiệu thật và một thương hiệu phim |
| MV-15 | Recording pipeline (`recording/*`)                                           | pack:marketing-video | #45  | Viết lại `transcribe.py` không dùng `shell=True`       |
| MV-16 | Brief caption tiếng Việt                                                     | pack:marketing-video | #45  |                                                        |
| MV-17 | Doc story/shot và motion craft                                               | pack:knowledge       | #48  |                                                        |
| MV-18 | Doc orchestration (gắn với harness nguồn)                                    | loại bỏ              | #46  | Agent của Studix có contract riêng                     |

## ak-motion-design

| ID    | Thành phần                                                         | Loại                 | Đích | Ghi chú                                |
| ----- | ------------------------------------------------------------------ | -------------------- | ---- | -------------------------------------- |
| MD-01 | Checklist 8 bước, bảng tính cách, thời lượng, stagger, `director/` | pack:knowledge       | #48  |                                        |
| MD-02 | `patterns/`, `reference/`, `references/easing-selection.md`        | pack:knowledge       | #48  | Gộp hai bảng easing                    |
| MD-03 | `references/common-pattern-recipes.md`                             | loại bỏ              | #48  | Trùng `patterns/`                      |
| MD-04 | Bảng route sang skill khác                                         | loại bỏ              | #48  | Mâu thuẫn route Remotion               |
| MD-05 | `references/marketing-surface-playbooks.md`                        | pack:marketing-video | #45  | Kiểm chứng giới hạn quảng cáo hiển thị |

## ak-hyperframes

| ID    | Thành phần                                             | Loại         | Đích | Ghi chú                               |
| ----- | ------------------------------------------------------ | ------------ | ---- | ------------------------------------- |
| HF-01 | `verify-prereqs.mjs`                                   | core         | #42  |                                       |
| HF-02 | Composition basics (thuộc tính `data-*`)               | adapter      | #42  |                                       |
| HF-03 | Render workflow và pin CLI                             | adapter      | #42  | Pin trong image, không `npx` lúc chạy |
| HF-04 | Cloud render tính tiền                                 | human review | #42  |                                       |
| HF-05 | Index skill bên thứ ba và lựa chọn thay thế clone repo | loại bỏ      | #42  | Rủi ro chuỗi cung ứng                 |

## ak-remotion

| ID    | Thành phần                                          | Loại                | Đích | Ghi chú                          |
| ----- | --------------------------------------------------- | ------------------- | ---- | -------------------------------- |
| RM-01 | Rule composition, sequencing, timing, media loading | pack:knowledge      | #48  | Không fetch media từ xa lúc chạy |
| RM-02 | Rule caption và transcription                       | adapter             | #41  | Whisper là provider              |
| RM-03 | Ví dụ chart và text animation                       | pack:motion-graphic | #45  |                                  |
| RM-04 | Remotion làm renderer thay thế                      | human review        | #42  | License thương mại               |

## ak-media-processing

| ID    | Thành phần                                                 | Loại    | Đích | Ghi chú                             |
| ----- | ---------------------------------------------------------- | ------- | ---- | ----------------------------------- |
| MP-01 | `media_convert.py`, `video_optimize.py`, `batch_resize.py` | core    | #42  | Bỏ `-y`; không ghi đè ngầm          |
| MP-02 | `scripts/tests/`                                           | core    | #42  |                                     |
| MP-03 | Script RMBG (Bash, Node)                                   | adapter | #41  | Bỏ `npm install -g`; pin model      |
| MP-04 | Hướng dẫn FFmpeg và ImageMagick chung                      | loại bỏ | #42  | Kiến thức chung, trùng doc upstream |

## ak-elevenlabs

| ID    | Thành phần                                         | Loại           | Đích | Ghi chú                                 |
| ----- | -------------------------------------------------- | -------------- | ---- | --------------------------------------- |
| EL-01 | TTS generator và bảng năng lực theo model          | adapter        | #41  |                                         |
| EL-02 | SFX và nhạc                                        | adapter        | #41  |                                         |
| EL-03 | Quản lý giọng (xóa)                                | human review   | #41  | Thao tác không đảo ngược                |
| EL-04 | Clone giọng                                        | human review   | #41  | Consent và pháp lý                      |
| EL-05 | Hướng dẫn viết thoại và diễn xuất                  | pack:knowledge | #48  |                                         |
| EL-06 | `available-models.md`, `load_env()` tìm `.env` lan | loại bỏ        | #41  | Danh mục cũ; credential qua `secretRef` |
| EL-07 | Hướng dẫn conversational agent                     | loại bỏ        | #41  | Ngoài phạm vi                           |

## ak-shader

| ID    | Thành phần                                                   | Loại           | Đích | Ghi chú                 |
| ----- | ------------------------------------------------------------ | -------------- | ---- | ----------------------- |
| SH-01 | Fundamentals, shaping, màu, SDF, noise, fBm, texture thủ tục | pack:knowledge | #48  | Dùng bởi film-engine GL |
| SH-02 | Tham chiếu hàm built-in                                      | loại bỏ        | #48  | Spec GLSL chung         |
| SH-03 | License nội dung phái sinh                                   | human review   | #48  |                         |

## ak-threejs

| ID    | Thành phần                                 | Loại           | Đích | Ghi chú                   |
| ----- | ------------------------------------------ | -------------- | ---- | ------------------------- |
| TJ-01 | `search.py`, `core.py` BM25                | core           | #48  | Gộp với CR-01             |
| TJ-02 | CSV API, category, use case và guide 00–18 | pack:knowledge | #48  | Theo phiên bản Three.js   |
| TJ-03 | `examples-all.csv`                         | human review   | #48  | License dữ liệu phái sinh |
| TJ-04 | Script trích dữ liệu                       | loại bỏ        | #48  |                           |

## Primitive chung: character, continuity, storyboard, lipsync

`anime-creator` và `ak-filmmaking` giải cùng bốn bài toán bằng hai contract khác nhau.
Studix giữ một primitive trong engine (#43 cho contract storyboard, #47 cho phần còn
lại); pack `anime` và `long-form film` chỉ cấu hình nó.

| Mảng       | anime-creator                                                                | ak-filmmaking                                                                | Hướng gộp                                                                                                        |
| ---------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Character  | AC-08: bible với anchors, silhouette, palette, voice; vai trò ảnh tham chiếu | FM-04: `identity_version`, ảnh tham chiếu có `view` và vòng đời              | Lấy vòng đời và versioning của FM-04, thêm anchors, palette, voice và vai trò ảnh của AC-08; enum `view` mở rộng |
| Continuity | AC-09: state phẳng, `state_before/after`, invariants, ba chế độ biên shot    | FM-05: vị trí màn hình, đạo cụ, điều kiện, hướng, thay đổi khai báo          | Một diff state theo chuỗi shot với thay đổi khai báo; chế độ biên shot là thuộc tính của cut                     |
| Storyboard | AC-07: rải ở bốn file, EDL và filmspec chồng nhau                            | FM-06: một `shot.json` mỗi shot, một still, animatic                         | Một `Storyboard`/`ShotSpec` trong `@studix/video-ir`; START/END của ak-video (AV-04) chờ quyết định              |
| Lipsync    | AC-10, AC-11: khớp take TTS, gate 3 frame, đo lag miệng                      | FM-07, FM-08: cue và alignment, enum none/native/dedicated, gate audio trước | Contract alignment và gate của FM-07; tool đo của AC-10 làm evidence; ngưỡng và bảng ngân sách theo pack         |

## Thống kê

Tổng 130 thành phần, 10 dòng thuộc primitive chung (★).

| Loại                 | Số dòng |
| -------------------- | ------: |
| core                 |      46 |
| pack:anime           |       5 |
| pack:marketing-video |       8 |
| pack:motion-graphic  |       2 |
| pack:long-form-film  |       5 |
| pack:knowledge       |       9 |
| adapter              |      18 |
| loại bỏ              |      20 |
| human review         |      17 |

| Sub-issue | Số dòng |
| --------- | ------: |
| #41       |      22 |
| #42       |      22 |
| #43       |       9 |
| #44       |      10 |
| #45       |      14 |
| #46       |       3 |
| #47       |      23 |
| #48       |      21 |
| #49       |       3 |
| #50       |       3 |
