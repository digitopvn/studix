# 0013. Port lai và port theo pack từ anime-creator và agentkit

- Status: Accepted
- Date: 2026-10-31

## Context

Epic [#2](https://github.com/digitopvn/studix/issues/2) tổng quát hóa skill
`anime-creator` (`zuey-workspace`, v1.6.0) và 11 skill video/motion của
`agentkit` thành các workflow pack chạy trên một engine dùng chung. Quyền dùng
nguồn và hai SHA đã pin được ghi trong [PORTING.md](../PORTING.md#nguồn-zuey-workspace-và-agentkit).
Audit tại SHA đã pin ([migration matrix](../porting/migration-matrix.md)) cho thấy:

- Nguồn là một pipeline dựa trên file, điều phối bằng Python CLI và Node script,
  gọi `ffmpeg`, `npx hyperframes`, `multix`, ComfyUI và `codex` qua subprocess.
  Trạng thái nằm trong JSON/JSONL cạnh project (`edl.json`, `gen-plan.json`,
  `continuity.json`, `runs.jsonl`).
- Phần đo đạc có giá trị nhất (loudness, true peak, black frame, lệch tiếng-hình,
  lip-sync lag, beat grid, continuity diff) viết bằng Python với numpy, scipy,
  OpenCV, onnxruntime và tùy chọn torch. Viết lại sang TypeScript tốn công và mất
  golden test sẵn có.
- Phần điều phối (stage, gate, budget, ledger, trạng thái job) trùng vai trò với
  `@studix/workflow`, `@studix/core` và `@studix/billing`, vốn đã có Postgres queue,
  lease, tenancy và ledger.
- Tri thức sản xuất chia thành hai lớp: phần chung (character, continuity,
  storyboard, lipsync, timeline, mix, QA) và phần riêng thể loại (series bible và
  tier của anime, style profile của motion graphic, recording pipeline của
  marketing). `anime-creator` và `ak-filmmaking` lặp lại nhau ở bốn mảng
  character, continuity, storyboard và lipsync.
- Nguồn có rủi ro không thể mang thẳng vào môi trường multi-tenant: `shell=True`
  với text do người dùng nhập trên Windows, `npx -y` và `uv run --with` không pin,
  đọc `.env` trong thư mục home, gọi provider trả tiền không có dry-run hay trần
  chi, và bảng giá có khuyến mãi hết hạn.

## Decision

### 1. Port lai: lõi TypeScript, Python tool trong sandbox worker

- Điều phối, contract và trạng thái viết bằng TypeScript trong các package hiện có.
  Stage là node có kiểu trong `@studix/workflow`; contract (`Storyboard`, `Shot`,
  `CharacterBible`, `ContinuityState`, `AudioTrack`) thuộc `@studix/video-ir`;
  budget và chi phí đi qua `@studix/billing`. Script điều phối của nguồn
  (`anime-studio.py`, các `.mjs` dựng timeline) không được port nguyên, chỉ lấy
  logic.
- Công cụ đo đạc và xử lý media bằng Python được giữ ở Python, đóng gói thành
  typed tool: mỗi tool có input/output schema, chạy trong vai trò worker cô lập
  (ADR [0011](0011-claude-agent-runtime-and-provider-auth.md) đã đặt subprocess ở
  worker), với thư mục làm việc tạm, không có secret của tenant, không có mạng trừ
  khi tool khai báo, giới hạn thời gian và bộ nhớ. Dependency Python được pin trong
  image worker, không cài lúc chạy. Tool cần torch nằm trong image tùy chọn.
- Golden test của nguồn (`scripts/tests`) được port cùng tool để giữ hành vi đã đo.
- Provider và renderer chỉ được gọi qua `MediaProvider` và `RendererAdapter`
  (ADR [0010](0010-renderer-and-media-provider-adapters.md)). Lệnh shell của nguồn
  không được copy; mọi subprocess dùng argv, không qua shell.

### 2. Port theo pack

- Engine dùng chung không biết thể loại. Mỗi thể loại là một workflow pack trong
  `@studix/skills`: `anime`, `marketing-video`, `motion-graphic`, `long-form film`
  và các knowledge pack. Pack khai báo template stage, gate, schema mở rộng,
  knowledge cần nạp và check `hard` hoặc `evidence`.
- Character, continuity, storyboard và lipsync là một primitive chung của engine.
  Pack `anime` và `long-form film` dùng cùng primitive này thay vì mỗi pack giữ một
  bản. Phần riêng của anime (tier, gate G0–G4, action-plan grammar, preset FX) nằm
  trong pack.
- Knowledge pack chỉ được nạp bởi stage cần nó.
- Port theo từng sub-issue #41–#50, mỗi sub-issue một PR. Migration matrix là bản
  đồ; một thành phần đổi loại thì cập nhật matrix trong cùng PR.

## Consequences

- Worker cần thêm runtime Python và dependency đã pin; image lớn hơn, image có torch
  tách riêng.
- Ranh giới TS–Python là một contract phải test: schema của typed tool và golden
  test là bằng chứng.
- Thêm thể loại mới bằng một pack, không đổi engine. Đổi primitive chung ảnh hưởng
  mọi pack, nên phải có test của cả `anime` lẫn `long-form film`.
- Giá và model ID trong nguồn không được tin; adapter dùng catalog sống và probe
  trước khi chi tiền cho model chưa đo.
- Nội dung nhạy cảm của nguồn (tên thương hiệu thật trong alias style, tên phim và
  studio có sẵn, bản ghi benchmark) không vào Studix nếu chưa qua human review.

## Alternatives considered

- **Viết lại toàn bộ bằng TypeScript.** Một runtime duy nhất, nhưng mất các golden
  test, phải tìm thư viện TS tương đương cho DSP và vision, và chậm epic nhiều tuần.
- **Chạy nguyên skill nguồn trong worker.** Nhanh nhất, nhưng mang theo trạng thái
  dựa trên file, shell không an toàn, dependency không pin và không có tenancy hay
  ledger.
- **Một pack lớn cho mọi thể loại, hoặc mỗi skill nguồn thành một pack.** Pack lớn
  ép thể loại vào lõi; một skill một pack giữ nguyên phần trùng giữa
  `anime-creator` và `ak-filmmaking`.
