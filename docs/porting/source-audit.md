# Audit 12 nguồn tại SHA đã pin

Audit chỉ đọc, bằng `git ls-tree` và `git show` tại SHA ghi trong
[PORTING.md](../PORTING.md#nguồn-zuey-workspace-và-agentkit). Không checkout, không
chạy script hay test của nguồn. Path dưới đây tương đối với thư mục skill. Cách xếp
loại từng thành phần nằm ở [migration-matrix.md](migration-matrix.md).

Một phát hiện đánh dấu _chưa kiểm chứng_ là thứ audit chỉ thấy qua header hoặc grep,
chưa đọc hết code. Giá là giá nguồn ghi lại, không phải giá đã kiểm tra lại.

## Tổng quan

| Nguồn                 | Path trong repo nguồn                      | Số file | Ngôn ngữ script    | Rủi ro chính                                                          |
| --------------------- | ------------------------------------------ | ------: | ------------------ | --------------------------------------------------------------------- |
| `anime-creator`       | `.agents/skills/anime-creator`             |     151 | Python, Bash, JS   | Download không pin, đọc `~/.multix/.env`, giá khuyến mãi hết hạn      |
| `ak-motion-video`     | `kits/marketing/skills/ak-motion-video`    |     136 | Python, Node       | `shell=True` với text người dùng trên Windows, gọi trả tiền không cap |
| `ak-filmmaking`       | `kits/marketing/skills/ak-filmmaking`      |      70 | Python (stdlib)    | Thấp; symlink trong thư mục film                                      |
| `ak-video`            | `kits/marketing/skills/ak-video`           |      24 | Node (`.cjs`)      | Shell injection qua tên file, `npx -y` không lock, giá cứng           |
| `ak-creativity`       | `kits/marketing/skills/ak-creativity`      |      15 | Python (stdlib)    | Thấp                                                                  |
| `ak-motion-design`    | `kits/marketing/skills/ak-motion-design`   |      21 | không có           | Không đáng kể                                                         |
| `ak-hyperframes`      | `kits/core/skills/ak-hyperframes`          |       8 | Node               | Kênh cài skill bên thứ ba, cloud render tính tiền                     |
| `ak-remotion`         | `kits/core/skills/ak-remotion`             |      33 | không có (TSX mẫu) | Fetch media từ xa, license Remotion                                   |
| `ak-media-processing` | `kits/engineer/skills/ak-media-processing` |      22 | Python, Bash, Node | `npm install -g` không pin, `ffmpeg -y` ghi đè                        |
| `ak-elevenlabs`       | `kits/marketing/skills/ak-elevenlabs`      |      16 | Python             | Tìm `.env` ở nhiều thư mục kể cả home, clone giọng cần consent        |
| `ak-shader`           | `kits/engineer/skills/ak-shader`           |      13 | không có           | License nội dung tham khảo                                            |
| `ak-threejs`          | `kits/engineer/skills/ak-threejs`          |      29 | Python (stdlib)    | License dữ liệu ví dụ phái sinh                                       |

## anime-creator (`zuey-workspace` `10719856`, v1.6.0)

**Path chính.** `SKILL.md` (pha, failure mode, tiêu chí xong); `references/` (17 playbook
theo pha); `scripts/` (khoảng 28 CLI, `anime-studio.py` là dispatcher), `scripts/studio/`
(khoảng 35 module dùng chung), `scripts/tests/` (khoảng 22 file pytest);
`assets/templates/` (character, set, continuity, engines, price table, gen-plan, action
plan, scope lock, QA rubric); `assets/film-engine/` (engine Three.js/GL dùng chung và
template scene HyperFrames); `assets/comfyui-workflows/` (hai workflow i2v chạy local);
`knowledge/` (index và bảy pack: narrative, performance, art-direction, dop-camera,
wardrobe-props, physics-lite, sound); `plans/reports/` (hai bản ghi benchmark).

**Stages.** 0 Setup (`preflight`, `init-series`) → 1 Interview → 2 Scope lock (gate G0,
người dùng) → 3 Thiết kế: sheet nhân vật, set frame, giọng (G1, người dùng) → 4 Keyframe:
staging, storyboard, job gen-plan, QA, retake → 5 Animatic (G2) → 6 Video: cloud tier
T2/T3 và local, cộng GL, FX, SFX, nhạc → 7 Conform: fetch, `qa-prescan`, trim, upscale →
8 Rough cut (G3) → 9 Final: grade, loudness, báo cáo (G4). Với `--auto` chỉ G2–G4 tự
động. Job trả tiền đi qua `planned → submitted → done | rejected | failed | cancelled`,
trần chi đặt ở G0, trace ghi vào `logs/trace.jsonl`.

**Contracts.** File theo series: `studio.json`, `episode.json`, `gen-plan.json`,
`runs.jsonl`, `renders/deliveries.jsonl`. `edl.json`: `fps`, `shots[]` với `id`, `kind`
(gl, video, cel), `start`/`end`, `src`/`in`/`speed`, `audio`, `tier`, `beat`,
`dialogue[]`, `boundary`. `engines.json`: role → adapter có `kind` là cli, comfyui hoặc
atlas-async. `price-table.json`: mỗi giá có `basis` là measured, catalog hoặc assumed.
Khóa shot `ep01/sc02/s06`. Writer chỉ ghi đề xuất vào `work/`; chỉ bước merge có khóa mới
sửa EDL hay mix.

**Scripts.** Điều phối: `anime-studio.py` (render qua `npx -y hyperframes@0.8.77`). Sinh
media trả tiền: `generate-media-via-multix.py`, `draw-images-via-codex.py` (`codex exec`
với workspace-write), `generate-video-via-comfyui.py` (HTTP tới ComfyUI local). Audio:
`align-vo-to-omni.py`, `retime-vo-line.py`, `gate-tts-takes.py`, `build-audio-mix.py`,
`audit-mix-buses.py`, `make-space-ir.py`, `mix-shape-features.py`,
`make-voice-variants.py`. Video và vision: `finish-scenes.py`, `assemble-episode.py`,
`upscale-finished-scenes.py`, `chroma-key-cutout.py`, `track-plate-motion.py`,
`warp-plate-yaw-perspective.py`, `estimate-plate-depth.py`, `make-depth-maps.py`,
`measure-reference-cut.py`. QA: `qa-prescan.py`, `qa-shot-boundaries.py`,
`qa-gate-check.py`, `ai-shot-qa.py`, `make-review-tiles.py`. Bash:
`assets/film-engine/engine/build-scene.sh` (`npx -y esbuild@0.25.10`).

**Dependencies.** Python 3 không có file requirements; package cài lúc chạy qua
`uv run --with` không pin (numpy, opencv-python-headless, onnxruntime, pillow, torch,
transformers, pytest). Node/npx (esbuild, hyperframes tải lúc chạy, không lockfile).
three.js 0.180.0 và một font tải lúc init. CLI ngoài: ffmpeg/ffprobe, uv, multix, codex
(tùy chọn), ComfyUI.

**Provider và giá (USD, theo `price-table.json` và references).** Ảnh khoảng 0.026–0.027
mỗi ảnh (measured), 0.075 ở tier chuẩn (catalog). Video cloud từ khoảng 0.04 đến 0.30
mỗi giây tùy model và độ phân giải, có model tối thiểu 3–4 giây. Video local trên ComfyUI
đo trên một GPU 16 GB, không tốn phí mỗi clip. Upscale 0.0069 mỗi giây. TTS từ khoảng
0.0009 mỗi lần gọi đến 0.10 (catalog). Hai giá TTS khuyến mãi hết hạn 2026-11-12. SFX
khoảng 0.001–0.01 mỗi giây; nhạc 0.10 (assumed). Giá token Claude ghi cứng cho model ID cụ
thể (assumed). Ngân sách mặc định $4 cho 15 giây, đo được $3.80 cho một phim, khoảng $0.24
mỗi giây phim. Quy tắc: một khoản chi ngoài kế hoạch quá 20% trần thì dừng hỏi người
dùng; model chưa đo phải probe trước vì catalog từng sai tới 18 lần.

**Rủi ro bảo mật.**

- Không thấy `shell=True` hay `eval`; subprocess dùng argv. Override `ANIME_CLI_<NAME>` chạy
  lệnh tùy ý theo thiết kế.
- `telemetry_trace_and_ledger.py` đọc key từ `~/.multix/.env` bằng regex và gửi Bearer token
  tới API của provider qua HTTPS. Có hàm `redact()` và test, nhưng chưa kiểm chứng mọi
  đường lỗi đều không in key.
- Download không pin: three.js không có checksum, font lấy từ nhánh `main`, `npx -y` và
  `uv run --with` cài lúc chạy, `from_pretrained` không pin revision.
- Download kết quả SFX chỉ kiểm tra https ở URL đầu, không giới hạn kích thước, theo
  redirect.
- `src`/`out` tương đối trong EDL và gen-plan chưa kiểm tra chặn `..` (chưa kiểm chứng).
- Đường `codex` chạy với workspace-write: là ranh giới tin cậy cần review.
- Không có path tuyệt đối trong script; fixture test có chuỗi path người dùng làm dữ liệu.
- Nội dung: frontmatter `SKILL.md` nhắc tên một studio và một phim truyền hình có thật;
  `plans/reports/` và ghi chú nguồn trong price table có tên một series mẫu. Không được
  chép các tên này sang Studix.

**Bốn mảng trùng với `ak-filmmaking`.**

- **Character.** `bible/characters/<id>.json` (template `character.example.json`):
  `id`, `name`, `role`, `age_look`, năm `anchors`, `silhouette`, `handedness`, `props`,
  `palette`, `sheet`, `expressions`, `voice{provider, model, voice_id, language, accent,
  respellings}`, `acting`, `negatives`. `reference_roles.py` chia vai trò ảnh tham chiếu
  (identity, costume-prop, environment, spatial-blocking, motion-camera);
  `shot_prompt_compiler.py` dựng prompt từ bible, tối đa 3 ảnh tham chiếu.
- **Continuity.** `story/continuity.json`: `state` (khóa phẳng `char.attribute`),
  `open_threads`, `history`, `shots` theo `ep/sc/shot` với `state_before`, `state_after`,
  `invariants`, `changes`, `overrides`. `continuity_transition_validator.py` mang state
  theo thứ tự EDL, phân loại phát hiện là definite, suspected hoặc allowed, thoát mã 1
  khi có definite. `shot_boundary_contract.py` có ba chế độ biên: locked-composition,
  camera-transition, intentional-cut.
- **Storyboard.** Không có template board riêng. Danh sách shot rải ở bốn chỗ: bảng beat
  trong scope lock, `edl.json`, `scenes/<sc>/action-plan.json` (anticipation → execution
  → contact → reaction → recovery) và `filmspec.json`. EDL và filmspec chồng nhau mà không
  có gì bắt chúng khớp.
- **Lipsync.** `align-vo-to-omni.py` khớp take TTS vào đoạn thoại của video, kéo giãn trong
  0.85–1.15, gate `within_3_frames` ở 24 fps. `gate-tts-takes.py` kiểm từ, cao độ, độ dài.
  `media_inspection.py` đo `lip_sync_lag` (onset chuyển động miệng so với onset giọng, cần
  hộp miệng nhập tay). Judge bằng model chỉ là bằng chứng, không phải phán quyết.

## ak-filmmaking (`agentkit` `9fe46997`)

**Path chính.** `SKILL.md` (router, gate); `references/` (13 playbook); `schemas/` (9 JSON
Schema: `common`, `project`, `beat-sheet`, `character`, `bible-asset`, `scene`, `shot`,
`audio-cue`, `alignment`); `scripts/` (`film.py` CLI, `film_graph.py`, `film_schema.py`
validator stdlib, `film_checks.py`, `film_continuity.py`, `film_prompt.py`,
`film_reports.py`, `tests/test_film_tools.py` với 62 test); `assets/examples/` (fixture
JSON gốc, 3 scene, 13 shot); `evals/evals.json` (7 case routing).

**Stages.** `init` → `script` (kịch bản, beat sheet; người dùng review) → `breakdown`
(scene, shot, coverage, render class) → `bible` (người dùng duyệt identity chuẩn) →
`audio` (cue thoại, dialogue master, alignment) → `storyboard` → keyframe (chỉ STANDARD,
CHARACTER_CRITICAL, HERO) → `animatic` (người dùng ký duyệt) → `render` → `qc` (lỗi quay
về stage rẻ nhất) → `assemble`. Trạng thái shot: PLANNED, STORYBOARDED, APPROVED_FRAME,
GENERATED, LIPSYNCED, QC_FAILED, APPROVED, ASSEMBLED; `film.py validate` cưỡng chế gate.

**Contracts.** ID scene `S\d{2,3}`, shot `S\d{2,3}_SH\d{3}`, asset `UPPER_SNAKE`. Path
luôn tương đối; regex chặn path tuyệt đối, ổ đĩa, UNC và `..`. JSON parse chặt (chặn khóa
trùng và NaN). Object chi phí bắt buộc `amount`, `currency`, `source`.

**Scripts.** Toàn bộ Python 3 stdlib, không subprocess, không mạng, không biến môi trường.
Chỉ `init` và `timeline --write` ghi file.

**Dependencies.** Python 3 stdlib. ffmpeg chỉ là bên tiêu thụ ffconcat, không được gọi.

**Provider và giá.** Không cứng provider hay model trong code; tên model trong references
chỉ là ví dụ. Chi phí trong fixture ghi rõ là minh họa. Ba chế độ ngân sách low, balanced,
quality map tới tier economy, standard, premium.

**Rủi ro bảo mật.** Thấp. `check_media` và `ffconcat` nối path dưới thư mục film mà không
resolve symlink. `init` từ chối thư mục đích không rỗng. Chi phí chỉ tin được bằng trường
`source`.

**Bốn mảng trùng với `anime-creator`.**

- **Character.** `character.schema.json`: `identity_version`, `canonical_hair`,
  `accessories`, `voice.voice_ref`, `references[]` (mỗi ảnh có `view` trong 10 giá trị,
  `expression`, `status` canonical/candidate/retired, `version`, `promoted_from`).
  Validate bắt buộc ảnh `front` chuẩn cho mỗi identity version đang dùng. Đổi có chủ ý thì
  tăng `identity_version`; drift là lỗi QC, shot quay về STORYBOARDED. Enum `view` thiên về
  người đóng, pack anime cần mở rộng.
- **Continuity.** Object `continuity` trên shot: `screen_positions`, `prop_states`,
  `conditions`, `screen_direction`; `continuity_changes` là danh sách `{field, reason}`.
  `film_continuity.py` so mỗi nhân vật hoặc đạo cụ với shot gần nhất trước đó trong chuỗi;
  thay đổi không khai báo là lỗi tại timecode cắt, khai báo mà không đổi là cảnh báo, phát
  hiện vòng lặp.
- **Storyboard.** Mỗi shot là `scenes/<S>/shots/<id>/shot.json` (`shot_type` 15 giá trị,
  `lens`, `camera`, `action`, `emotion`, `duration_target`, `characters`, `wardrobe`,
  `props`, `visible_speakers`, `lipsync`, `render_class`, `retry_budget`, `estimate`,
  `state`, `storyboard`, `keyframe`, `generations[]`, `qc`). Mỗi shot một still. Animatic
  cần frame cho mọi shot.
- **Lipsync.** Cue thoại trong `audio/cues.json`, alignment trong
  `audio/alignment/<cue>.json` (bắt buộc span câu). Enum `lipsync` là none, native,
  dedicated. Shot có lipsync cần dialogue master và alignment trước; người nói hiện hình
  trong shot `none` là lỗi. Timeline luôn remux dialogue master.

## ak-video (`agentkit` `9fe46997`)

**Path chính.** `SKILL.md`, `references/` (14), `scripts/` (5 `.cjs`), `templates/` (4
JSON). Không có `package.json`, schema hay test.

**Stages.** Preflight → kịch bản → storyboard (`storyboard.md`, `storyboard.json`) → still
START/END → TTS và nhạc (mỗi bước có AI review) → clip video với review gate, tối đa 2 lần
thử lại → ffmpeg ghép và mix → export theo nền tảng → caption → review cuối. Gate là AI
review R1–R6 với ngưỡng 7 hoặc 8; không có người duyệt trước khi chi tiền sinh video.

**Contracts.** Template: `name`, `type`, `defaultAspectRatio`, `defaultDuration`,
`platforms`, `structure.scenes[]`, `promptTemplate` (placeholder `{user_prompt}`,
`{aspect_ratio}`, `{brand_*}`), `audioConfig`, `styleGuide`, `variations`. Storyboard:
`scene_num`, `timing`, `start_frame`/`end_frame`, `motion`, `audio`, `review_notes`. Tên
file still mâu thuẫn giữa doc (`scene-N-start.png`) và script (`frame-NN.png`).

**Scripts.** Node: `generate-video.cjs`, `create-storyboard.cjs`, `analyze-video.cjs`,
`extract-captions.cjs` dùng `execFileSync` với argv. `optimize-for-platform.cjs` dùng
`execSync` với chuỗi shell ghép path vào/ra.

**Dependencies.** Node 20+, `@mrgoonie/multix@0.2.0` tải lúc chạy bằng `npx -y`, ffmpeg.

**Provider và giá.** Model video, ảnh, TTS, nhạc và review của Gemini/Veo/Imagen/MiniMax,
tên model không nhất quán giữa doc và code. `quality-review-workflow.md` ghi cứng chi phí
mỗi asset (giá nhớ lại, không kiểm chứng). Mức audio và giới hạn độ dài nền tảng mâu thuẫn
giữa các file.

**Rủi ro bảo mật.** Shell injection thật ở `optimize-for-platform.cjs`: tên file có dấu
nháy hoặc ký tự shell sẽ chạy lệnh. Mỗi lần gọi multix tải package không lock và package
đó nhận credential. Video và brand text gửi tới API bên thứ ba. Tên template nối vào path
không validate (chỉ đọc local).

## ak-creativity (`agentkit` `9fe46997`)

**Path chính.** `SKILL.md`; `data/` (5 CSV: 55 style, 18 nền tảng, 12 voiceover, 17 nhạc,
30 luật suy luận); `references/` (6); `scripts/` (`core.py` BM25 trên CSV, `search.py`,
`creative_brief.py`).

**Stages.** Phân tích yêu cầu → `search.py --creative-brief` (luật, style, nền tảng,
voiceover, nhạc) → tìm theo domain → nạp reference. Không có gate; kết quả chỉ để tư vấn.

**Contracts.** Header CSV cố định; `Decision_Rules` là JSON trong CSV. Kết quả tìm kiếm
`{domain, query, file, count, results[]}`.

**Scripts và dependencies.** Python 3 stdlib, không mạng, không subprocess.

**Provider và giá.** Không có. Spec nền tảng chưa kiểm chứng; `visual-trends.md` có số
liệu không nguồn.

**Rủi ro bảo mật.** Thấp.

## ak-motion-video (`agentkit` `9fe46997`, v1.6.0)

**Path chính.** `SKILL.md`, `LICENSE.txt` (proprietary, có phần MIT của bên thứ ba);
`references/` (14 doc: pipeline, beat sync, composition contract, orchestration, motion
craft, generated art, recording, reframe, story/shot, caption tiếng Việt, style system);
`references/styles/index.yaml` và `styles/profiles/*.yaml` (70 profile: 40 lấy cảm hứng
từ thương hiệu, 28 thẩm mỹ, 2 nội bộ); `scripts/` (14 và 8 test);
`assets/templates/` (4 `.mjs`, `index-skeleton.html`, `hyperframes.json`, dữ liệu mẫu,
`recording/` 9 bước Python).

**Stages.** 0 `doctor.py` → 1 fact và `script.json` (`en`, `say`, `vi`), `style.json`;
beat map hiện một lần → 2 direction brief, gate duyệt brief trước VO → 3 sinh VO, SFX,
nhạc (gọi trả tiền) → 4 `align-voiceover.mjs` → 5 beat grid, arrangement, verify ±2 ms → 6
`build-timeline.mjs` (TIMING, caption, mix) và đo cân bằng mix → 7 dựng scene → 8
`assemble.py`, `validate.py`, contact sheet, `check-bounds.mjs` → 9 render, remux
`mix.m4a`, `probe.py` (ebur128, blackdetect) → 10 encode social; reframe chỉ sau khi duyệt
master. Chế độ `--from-recording` thay bước 1–5 bằng transcribe → segment → EDL → caption.

**Contracts.** Root `data-width`/`data-height`, `window.__timelines["main"]`, khối
`/*TIMING:BEGIN*/…/*TIMING:END*/`; fragment `scenes/<sid>.scene.html` ghép tại marker.
Dữ liệu: `script.json`, `style.json`, `sfx.json`, `cues.json`, `music-plan.json`,
`music-arrangement.json`, `vo-lines.json`, `timeline.json`, `captions-vi.json`,
`edl.json`. Mix: -14 LUFS, -1.5 dBTP, AAC 192k 48 kHz.

**Scripts.** Python: `doctor`, `assemble`, `validate`, `probe`, `contact-sheet`, `tl`,
`scaffold-scenes`, `resolve-style`, `reframe`, `audit-ratio-scope`, `fit-beat-grid`,
`measure-mix-balance`, `verify-arrangement`. Node: `check-bounds` (Playwright),
`build-timeline`, `arrange-music`, `generate-audio-assets`, `align-voiceover`.

**Dependencies.** Python 3 với numpy, scipy, PyYAML; Node 18+; ffmpeg; HyperFrames 0.8.77
(pin); GSAP 3.14.2 qua CDN không SRI; Playwright không pin; multix CLI.

**Provider và giá.** TTS Gemini, ElevenLabs cho SFX, nhạc, alignment và transcription;
ảnh qua Codex hoặc Gemini. Không có giá tiền hay trần chi.

**Rủi ro bảo mật.** `recording/transcribe.py` chạy multix với `shell=True` và hàm tự quote
cho cmd.exe; `align-voiceover.mjs` và `generate-audio-assets.mjs` dùng `spawn` với
`shell: true` trên Windows và đưa text thoại qua đó. `generate-audio-assets` không có
dry-run hay trần chi, `--force` sinh lại toàn bộ. `reframe.py` và `assemble.py` xóa nội
dung thư mục đầu ra có marker sở hữu. `hyperframes.json` trỏ registry bên thứ ba trên nhánh
`main`. Nội dung: alias của 40 profile nêu tên thương hiệu thật, một alias là tên một
thương hiệu phim, và có link bài đăng của một người sáng tạo.

## ak-motion-design (`agentkit` `9fe46997`)

**Path chính.** `SKILL.md`, `LICENSE.txt`, `director/` (8 nguyên tắc), `patterns/` (4
recipe), `reference/` (4 bảng), `references/` (3 doc). Không có script.

**Stages.** Checklist 8 bước (cảm xúc, tính cách, thuộc tính, thời lượng, easing, hero,
layer, quy tắc 1/3), đầu ra là motion brief.

**Contracts.** Bảng markdown: thời lượng theo loại phần tử, stagger, archetype tính cách,
bảng bezier.

**Dependencies, provider, giá.** Không có. Giới hạn quảng cáo hiển thị và bảng easing
trích không ghi phiên bản.

**Rủi ro bảo mật.** Không đáng kể. Chất lượng: `patterns/` và
`references/common-pattern-recipes.md` trùng nhau; bảng route Remotion mâu thuẫn với
`ak-motion-video`.

## ak-hyperframes (`agentkit` `9fe46997`)

**Path chính.** `SKILL.md`, `references/` (5), `scripts/verify-prereqs.mjs` và test.

**Stages.** init → sửa → preview → lint/check → render MP4, cloud render tùy chọn.

**Contracts.** Root HTML có `data-composition-id`, `data-start`, `data-width`,
`data-height`, `data-duration`; clip có `id`, `data-start`, `data-duration`.

**Scripts và dependencies.** `verify-prereqs.mjs` (Node, `spawnSync` với literal cố định).
Node 22+, FFmpeg, Chrome headless, `hyperframes@0.8.77` qua `npx`.

**Provider và giá.** Cloud render của HeyGen, 4K tính 1.5 lần; không có giá cứng.

**Rủi ro bảo mật.** Credential đọc từ env hoặc file trong home. GSAP từ CDN (pin phiên
bản). Doc gợi ý cài skill qua registry bên thứ ba và clone repo rồi `pnpm install`.

## ak-remotion (`agentkit` `9fe46997`)

**Path chính.** `SKILL.md`, `rules/` (32 rule markdown, 3 ví dụ TSX).

**Stages.** Không có pipeline; tra rule cần thiết rồi kiểm composition ID, kích thước,
fps, thời lượng, asset và đồng bộ audio.

**Contracts.** `<Composition>` với `id`, `durationInFrames`, `fps`, `width`, `height`,
`defaultProps`, `calculateMetadata`.

**Dependencies.** React, `remotion` và `@remotion/*` cài qua `npx remotion add` không pin;
tùy chọn whisper.cpp hoặc Whisper API.

**Provider và giá.** Không có giá cứng; transcription qua API là trả tiền.

**Rủi ro bảo mật.** Ví dụ fetch media và Lottie JSON từ xa lúc chạy. License thương mại của
Remotion cần kiểm tra trước khi dùng làm renderer.

## ak-media-processing (`agentkit` `9fe46997`)

**Path chính.** `SKILL.md`, `references/` (9 hướng dẫn FFmpeg, ImageMagick, RMBG),
`scripts/` (`media_convert.py`, `video_optimize.py`, `batch_resize.py`,
`remove-background.sh`, `batch-remove-background.sh`, `remove-bg-node.js`,
`requirements.txt`), `scripts/tests/` (3 pytest).

**Stages.** Chọn công cụ → chuyển đổi → kiểm codec, kích thước, thời lượng; giữ nguồn, ghi
batch ra thư mục riêng.

**Contracts.** Preset `web`, `archive`, `mobile` (CRF 23/18/26, audio 128k/192k/96k, chất
lượng ảnh 85/95/80); `-movflags +faststart`.

**Scripts và dependencies.** Python 3.10+ stdlib dùng argv, không shell; Bash quote đúng
nhưng chạy `npm install -g rmbg-cli` khi thiếu; Node dùng SDK `rmbg`. Không pin phiên bản.

**Provider và giá.** Không có; RMBG chạy model local, weight tải từ CDN.

**Rủi ro bảo mật.** Cài npm toàn cục không pin, URL model không pin, `ffmpeg -y` ghi đè
không hỏi.

## ak-elevenlabs (`agentkit` `9fe46997`)

**Path chính.** `SKILL.md`, `README.md`, `.env.example`, `requirements.txt`
(`elevenlabs>=1.0.0`), `references/` (7), `scripts/` (TTS, quản lý giọng, clone giọng,
SFX), `scripts/tests/` (1).

**Stages.** Chọn hành động (script, enhance, dialogue, speak, clone, sfx); viết tách khỏi
tổng hợp; tổng hợp cần SDK và API key; kiểm từ, thời lượng, định dạng.

**Contracts.** Bảng năng lực theo model (voice setting, hỗ trợ `<break>`, mã ngôn ngữ);
voice ID 20 ký tự; bảng tên → ID giọng có sẵn ghi cứng.

**Scripts và dependencies.** Python với SDK `elevenlabs` không pin; TTS ghi file tạm rồi
thay thế nguyên tử; quản lý giọng hỏi xác nhận khi xóa trừ khi `--force`.

**Provider và giá.** Liệt kê nhiều model ElevenLabs; không có giá tiền cứng, chỉ trỏ trang
giá.

**Rủi ro bảo mật.** `load_env()` tìm `.env` ở thư mục hiện tại, các thư mục cha của script
và home, nên một `.env` local có thể cấp key cho cuộc gọi trả tiền. Clone giọng gửi audio
người dùng cho provider; SKILL yêu cầu consent nhưng chưa kiểm chứng script có chặn.

## ak-shader (`agentkit` `9fe46997`)

**Path chính.** `SKILL.md`, 12 reference GLSL (fundamentals, shaping, màu, SDF, pattern,
noise, fBm, texture thủ tục, API). Không có script.

**Contracts.** Uniform `u_time`, `u_resolution`, `u_mouse`; snippet GLSL ES 1.

**Dependencies, provider, giá.** Runtime WebGL; không có provider.

**Rủi ro bảo mật.** Không chạy gì; một phần nội dung có thể phái sinh từ tutorial công
khai, cần kiểm license trước khi chép.

## ak-threejs (`agentkit` `9fe46997`)

**Path chính.** `SKILL.md`, `data/` (4 CSV: API, category, ví dụ, use case),
`references/` (19 guide đánh số 00–18), `scripts/` (`search.py`, `core.py` BM25,
`extract_examples.py`, `generate_csv_from_json.py`).

**Stages.** Tìm trong dữ liệu → chọn recipe → kiểm phiên bản Three.js và renderer → kiểm
render → giải phóng tài nguyên.

**Scripts và dependencies.** Python 3 stdlib; `search.py` cần thư mục script trên
`sys.path`.

**Provider và giá.** Không có.

**Rủi ro bảo mật.** Không gọi mạng khi tìm kiếm. Dữ liệu ví dụ phái sinh từ dự án bên
ngoài, cần kiểm license trước khi phân phối lại.

## Rủi ro xuyên suốt

1. **Shell không an toàn.** `optimize-for-platform.cjs` (ak-video) và đường multix trên
   Windows của ak-motion-video. Studix chỉ chạy subprocess bằng argv, không shell.
2. **Dependency cài lúc chạy.** `npx -y`, `uv run --with`, `npm install -g`, CDN không
   checksum. Studix pin trong image worker và lockfile.
3. **Credential từ file trong home hoặc `.env` tìm lan.** Studix chỉ dùng `secretRef` theo
   workspace, không đọc file trong home.
4. **Gọi trả tiền không trần chi.** Studix đi qua budget, ledger và gate duyệt trước khi
   chi (#40).
5. **Giá và model ID cũ hoặc mâu thuẫn.** Giá trong nguồn chỉ là tham khảo; adapter dùng
   catalog sống và probe.
6. **Nội dung cần review.** Tên thương hiệu thật trong alias style, tên phim, studio và
   series có sẵn, link người sáng tạo, dữ liệu phái sinh từ dự án bên ngoài.
