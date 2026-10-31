# QA

`@studix/qa` (`packages/qa`) chặn một stage khi file render đo ra ngoài giới hạn, ghi lại
bằng chứng cho người duyệt, và bắt buộc người thật duyệt bản render cuối. Các tool đo là
package Python `studix-qa` (`tools/qa`), chạy trong sandbox của worker theo
[ADR-0013](decisions/0013-hybrid-port-and-workflow-packs.md): lõi TypeScript, tool đo bằng
Python. Code là tài liệu tham chiếu; trang này ghi contract, ngưỡng và giới hạn.

## Ba lớp (Implemented)

| Lớp        | Ai quyết                        | Chặn stage | Code                                                              |
| ---------- | ------------------------------- | ---------- | ----------------------------------------------------------------- |
| `hard`     | Tool đo bằng máy                | Có         | `runHardGate`, `assertHardGate` (`qa-gates.ts`)                   |
| `evidence` | Detector, AI judge, check mềm   | Không      | `collectEvidence` (`qa-gates.ts`), `blocking: false`              |
| `human`    | Người duyệt qua approval policy | Có         | `createQaApprovalPolicy`, `assertHumanReview` (`human-review.ts`) |
- Một hard check trượt ném `VALIDATION` không retry được: chạy lại thì đo lại đúng file đó.
  Metric không đo được (thiếu stream, tool lỗi) thì check trượt (fail closed).
- Evidence không bao giờ chặn. Tool evidence lỗi được ghi thành item `ok: false`; chỉ
  `CANCELLED` được ném tiếp. Verdict của AI judge chỉ là evidence (matrix AC-29, AV-11).
- Action `render.final` luôn cần người duyệt, kể cả khi policy gốc miễn duyệt vì chi phí
  thấp. Approval do API key (client agent), system, hết hạn, sai action hay sai subject
  không được tính. Action khác đi qua policy gốc; policy gốc lỗi thì bắt duyệt (fail closed).

`createQaStages()` tạo hai stage cho pack: `qa_check` (hard gate rồi evidence) và
`qa_review` (khai báo `approval: { action: "render.final" }` nên engine dừng job chờ duyệt;
khi chạy, stage kiểm lại approval là của người). `review: false` bỏ stage thứ hai.

## Hard gate mặc định

`defaultHardChecks({ durationS?, fps?, requireAudio? })`:

| Check id                 | Metric                             | Giới hạn                                       |
| ------------------------ | ---------------------------------- | ---------------------------------------------- |
| `has-video`, `has-audio` | `probe.hasVideo`, `probe.hasAudio` | có stream                                      |
| `loudness`               | `loudness.integratedLufs`          | -14 LUFS ±1 (EBU R128, `ebur128`)              |
| `true-peak`              | `loudness.truePeakDbtp`            | ≤ -1.5 dBTP                                    |
| `not-all-black`          | `black.allBlack`                   | không đen toàn bộ                              |
| `leading-black`          | `black.leadingS`                   | ≤ 0,5 s (luma trung bình < 16)                 |
| `inner-black`            | `black.maxInnerRunS`               | ≤ 1 s                                          |
| `av-sync`                | `sync.audioDelayMs`                | audio sớm ≤ 40 ms, trễ ≤ 60 ms (EBU R37)       |
| `av-duration`            | `sync.durationDeltaMs`             | ±100 ms                                        |
| `duration`, `fps`        | `probe.durationS`, `probe.fps`     | khi truyền vào; dung sai max(0,1 s, một frame) |

Loudness và true peak trùng giới hạn renderer finish tới ([RENDERER.md](RENDERER.md)), nên
gate là phép đo độc lập trên file đã giao, không phải giới hạn thứ hai. `requireAudio: false`
bỏ các check âm thanh cho video im lặng.

### Check từ knowledge pack

Hard check của knowledge pack ([KNOWLEDGE_PACKS.md](KNOWLEDGE_PACKS.md)) gắn vào tool QA
theo `metric.id`. `bindHardChecks(knowledgeCatalog.hardChecks())` (`knowledge-checks.ts`)
trả về check sẵn cho `runHardGate` và danh sách `unbound`; threshold của pack giữ nguyên và
được quyết bằng `meetsThreshold`.

| `metric.id`                | Metric QA                 | Ghi chú                     |
| -------------------------- | ------------------------- | --------------------------- |
| `integrated-loudness-lufs` | `loudness.integratedLufs` |                             |
| `true-peak-dbtp`           | `loudness.truePeakDbtp`   |                             |
| `leading-black-s`          | `black.leadingS`          | chỉ `params.lumaFloor` = 16 |
| `delivery-file-mib`        | `probe.sizeMib`           |                             |
- Check có `pendingReview` (chủ sở hữu chưa duyệt ngưỡng) vào lớp evidence, không chặn.
- Check sai unit, hoặc có `params` khác giá trị tool đo, không được gắn (`unsupported_params`,
  `unit_mismatch`), thay vì đo theo cách khác rồi cho qua.
- Metric chưa có tool (`no_tool`) không bị bỏ ngầm: caller quyết có chấp nhận hay không.
  Metric mức shot (mix bus theo shot, lipsync) chưa gắn; biên shot của pack phim nằm trong
  `film.production` của IR.

### Gate cho stage của pack

`createHardQaGate` (`qa-hard-gate.ts`) là `QaGate` mà worker đưa cho stage QA của pack
(`marketing-video.qa`, `motion-graphic.qa`). Mỗi render chạy hard gate mặc định theo độ dài,
fps và việc có âm thanh hay không, cộng hard check đã gắn của các knowledge pack mà stage
khai báo (`hardChecksFor`). Render im lặng bỏ check loudness và sync của pack. Check nào
fail thì stage fail với `VALIDATION` không retry, nên không có file nào được upload. Các
check `unbound` được ghi vào output của stage.

## Tool đo (Implemented)

Mỗi tool là một module trong `tools/qa/src/studix_qa/`, bọc phía TS bằng một `QaTool` có
schema zod cho input và output (`qa-tools.ts`).

| Tool              | Lớp      | Đo gì                                                                             | Timeout | Bộ nhớ |
| ----------------- | -------- | --------------------------------------------------------------------------------- | ------- | ------ |
| `probe`           | hard     | ffprobe: container, stream, fps, duration, size                                   | 60 s    | 4 GiB  |
| `loudness`        | hard     | Integrated LUFS, true peak, LRA (`ebur128=peak=true`)                             | 10 min  | 4 GiB  |
| `black-frames`    | hard     | Đoạn đen đầu, cuối, giữa trên proxy 160x90                                        | 10 min  | 4 GiB  |
| `sync`            | hard     | Lệch start và duration giữa audio và video trong container                        | 60 s    | 4 GiB  |
| `prescan`         | evidence | Wedge, still hold, black, cut, click, dropout, transient (`qa-prescan`)           | 15 min  | 4 GiB  |
| `mix-buses`       | evidence | Mức bus beds/hits/vo/music theo shot (`audit-mix-buses`)                          | 10 min  | 8 GiB  |
| `judge-reports`   | evidence | Gộp report của AI reviewer (`qa-gate-check`)                                      | 60 s    | 4 GiB  |
| `shot-boundaries` | evidence | Pop luma, histogram, diff ở từng cut theo chế độ biên shot (`qa-shot-boundaries`) | 10 min  | 4 GiB  |
| `depth-maps`      | evidence | Depth map PNG bằng Depth Anything V2 Small; chỉ image `depth`                     | 15 min  | 8 GiB  |

Nguồn port và golden test ghi ở [PORTING.md](PORTING.md#port-record-tool-qa).

## Sandbox và giới hạn

Mỗi lần chạy, `runPythonTool` (`python-tool-runner.ts`):

- tạo thư mục tạm riêng (`work/`, `out/`) và xoá nó trong `finally`;
- chạy `python -I -m studix_qa <tool>` bằng argv, không shell; request và response là JSON
  trên stdin/stdout (request tối đa 8 MiB, stdout có giới hạn);
- truyền env sạch: chỉ `PATH`, locale, `HOME`/`TMP`/`TEMP`/`TMPDIR` trỏ vào sandbox,
  `HF_HUB_OFFLINE=1`, và biến `STUDIX_QA_*` caller cho phép. Không key provider, không
  `DATABASE_URL`, không secret nào khác;
- chỉ truyền media được cấp theo grant id, path tuyệt đối đã resolve, file thường. Tool
  không nhận path nào khác; mọi input ffmpeg dùng `-protocol_whitelist file`;
- đặt deadline trong tool, và kill cả cây tiến trình (process group trên POSIX, `taskkill /T`
  trên Windows) khi quá timeout cộng 5 s, hoặc khi job bị huỷ (`CANCELLED`);
- kiểm output bằng zod; output sai contract là `INTERNAL`.

**Giới hạn.** Chặn mạng (vá `socket` trong tiến trình) và `RLIMIT_AS` là phòng thủ trong
tiến trình, không phải cô lập. Python vẫn đọc được mọi file user của worker đọc được, và
ffmpeg con không bị giới hạn bộ nhớ. Cô lập thật là việc của container worker: user `node`,
không mount secret, egress theo policy của deployment ([SECURITY.md](SECURITY.md)). Tool
không gọi API trả tiền và không tải gì lúc chạy.

**Giới hạn của phép đo.**

- `sync` chỉ đo căn chỉnh audio/video ở mức container (start, duration), không đo khẩu hình.
  Lipsync thuộc #47.
- `black-frames` và `prescan` đo trên proxy xám nhỏ: phát hiện đoạn đen, hold, wedge rõ ràng,
  không đánh giá chất lượng hình.
- `shot-boundaries` đo từng cut của một bản render (luma, histogram, tỉ lệ diff qua cut so với
  diff trong shot). Join lấy từ `film.production` bằng `filmShotJoins` (`film-shot-joins.ts`).
  Cut `intentional-cut` luôn được cho qua. Tool chưa gắn vào hard gate của pack phim: kết quả
  là evidence cho reviewer.
- Gate chạy trên một file; mỗi delivery (master, preview, phone) là một lần gọi.
- `qa_check` chưa gắn vào `video.create` của brand intro: pack tự thêm stage khi cần, vì
  brand intro có thể im lặng và mọi job khi đó sẽ cần Python.

## Image và toolchain

- **Image mặc định.** `Dockerfile` cài `python3` của Debian và tạo `tools/qa/.venv` bằng
  `uv sync --locked --no-dev` từ `tools/qa/uv.lock`; uv chỉ có lúc build. Không có torch.
- **Image `depth` (tùy chọn).** `docker build --build-arg STUDIX_QA_EXTRAS=depth .` cài
  extra `depth` (torch CPU, transformers, pillow) và tải sẵn model
  `depth-anything/Depth-Anything-V2-Small-hf` tại revision pin trong
  `ARG DEPTH_MODEL_REVISION` vào `/opt/studix-qa/models/`. Lúc chạy model chỉ đọc local
  (`local_files_only`); đổi path bằng `STUDIX_QA_DEPTH_MODEL`. Trên image mặc định,
  `depth-maps` trả `UNAVAILABLE`.
- **Local.** `pnpm test:qa` sync `tools/qa/.venv` bằng uv (`uv` trên PATH, hoặc
  `python -m uv`) rồi chạy pytest. Venv đó là interpreter `packages/qa` dùng mặc định;
  `STUDIX_QA_PYTHON` trỏ sang interpreter khác.
- **Test.** `pnpm test` chạy `test:qa` trước vitest. Media test sinh bằng ffmpeg `lavfi`.
  Thiếu ffmpeg hay venv thì test e2e skip kèm lý do; CI đặt `STUDIX_QA_REQUIRE_TOOLCHAIN=1`
  để thiếu toolchain là fail.

## Thêm tool đo mới

1. **Module Python.** Thêm `tools/qa/src/studix_qa/<tên>.py` có `run(payload, media, deadline, outputs)`
   trả dict JSON; file ra chỉ ghi qua `outputs.path(tên)`. Đọc media qua `media.path(id)`, gọi ffmpeg qua `ff.ffmpeg` / `ff.ffprobe_json`
   (argv, deadline, guard protocol). Lỗi ném `ToolError` với mã trong `ERROR_CODES`. Không
   `shell=True`, không `os.system`, không mạng (test contract kiểm source).
2. **Đăng ký.** Thêm tên vào `TOOLS` trong `studix_qa/__init__.py`.
3. **Test Python.** Thêm test pytest trong `tools/qa/tests/` với media `lavfi`, gồm ít nhất
   một case pass và một case fail. Port từ nguồn thì ghi nguồn ở đầu file.
4. **Wrapper TS.** Thêm `QaTool` vào `QA_TOOLS` (`qa-tools.ts`): schema input/output zod,
   `mediaRefs`, timeout, bộ nhớ, image.
5. **Metric.** Metric chặn stage: thêm vào `QA_METRICS` (`qa-checks.ts`) và đọc kết quả trong
   `runHardGate`. Metric mà knowledge pack đã khai báo: thêm dòng vào `QA_METRIC_BINDINGS`
   (`knowledge-checks.ts`) với đúng unit và `params` tool dùng.
6. **Dependency.** Thêm vào `tools/qa/pyproject.toml`, chạy `uv lock`. Dependency nặng (torch,
   model) đi vào extra riêng và image tùy chọn, không vào image mặc định.
7. **Docs.** Cập nhật bảng tool ở trên và port record trong [PORTING.md](PORTING.md).
