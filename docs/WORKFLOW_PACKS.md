# Workflow pack

Workflow pack là một thể loại video (brand intro, marketing video, motion graphic, anime, phim dài)
đóng gói cho engine dùng chung: template, các stage có kiểu, và pipeline đan các stage đó vào giữa
stage của engine. Engine không biết thể loại; MCP server và worker chỉ đọc pack registry. Quyết định
nền: [ADR-0013](decisions/0013-hybrid-port-and-workflow-packs.md) (port theo pack),
[ADR-0014](decisions/0014-storyboard-revisions-and-stage-cache.md) (stage có schema, cache,
registry), [ADR-0015](decisions/0015-agent-stage-caps-and-host-handoff.md) (agent stage),
[ADR-0010](decisions/0010-renderer-and-media-provider-adapters.md) (adapter provider).

Status: **Implemented** trong `packages/workflow`, `packages/skills` và `packages/providers`. Code là
chuẩn; trang này ghi contract dùng để làm gì, nằm ở đâu, cách thêm pack và cách đọc lỗi thường gặp.
Hành vi từng pack mà MCP client thấy được ghi ở [MCP_API.md](MCP_API.md#p0-native-tools); số đo
benchmark ở [METRICS.md](METRICS.md#vertical-benchmark-epic-2).

## Bản đồ code

| Cần gì                                                                                      | Ở đâu                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kiểu contract: `StageDefinition`, `StageContext`, `PackPipeline`, `EngineStages`, `PackJob` | [`workflow-types.ts`](../packages/workflow/src/workflow-types.ts)                                                                                                                                         |
| Thứ tự runner xử lý một stage, media journal, stage cache, `stageCacheKey`                  | [`stage-runner.ts`](../packages/workflow/src/stage-runner.ts)                                                                                                                                             |
| Retry, lease, deadline, cancel                                                              | [`job-executor.ts`](../packages/workflow/src/job-executor.ts), [`retry-backoff.ts`](../packages/workflow/src/retry-backoff.ts)                                                                            |
| Stage engine của `video.create`, chọn pipeline theo pack                                    | [`video-create-workflow.ts`](../packages/workflow/src/video-create-workflow.ts)                                                                                                                           |
| Payload `video.create`, schema checkpoint, `irOf`, `payloadOf`                              | [`video-create-checkpoints.ts`](../packages/workflow/src/video-create-checkpoints.ts)                                                                                                                     |
| Approval gate, creative gate, agent stage                                                   | [`approval-gate.ts`](../packages/workflow/src/approval-gate.ts), [`creative-gate-stage.ts`](../packages/workflow/src/creative-gate-stage.ts), [`agent-stage.ts`](../packages/workflow/src/agent-stage.ts) |
| `requireService`, `stageWorkDir`, `mapBounded`; `StageSuspended`, `StageFailedAfterSpend`   | [`stage-services.ts`](../packages/workflow/src/stage-services.ts), [`stage-signals.ts`](../packages/workflow/src/stage-signals.ts)                                                                        |
| `WorkflowPack`, `createPackRegistry`, `packPipelines`                                       | [`pack-registry.ts`](../packages/skills/src/pack-registry.ts)                                                                                                                                             |
| Registry của process và danh sách pack có sẵn                                               | [`skill-registry.ts`](../packages/skills/src/skill-registry.ts)                                                                                                                                           |
| Sinh media rồi lưu vào storage của tenant, tính phí kể cả khi fail                          | [`stored-media.ts`](../packages/skills/src/stored-media.ts)                                                                                                                                               |
| Nơi worker nối registry, service và pipeline                                                | [`wiring.ts`](../apps/worker/src/wiring.ts), [`pack-services.ts`](../apps/worker/src/pack-services.ts)                                                                                                    |
| Nơi MCP server kiểm `workflowTemplate`                                                      | `resolveWorkflowPack` ([`workflow-template.ts`](../packages/core/src/studio/workflow-template.ts))                                                                                                        |

## Contract

### Pack và pipeline

- `WorkflowPack` gồm `id` (kebab-case, duy nhất), `templates`, `stages` và `pipeline` tùy chọn. Pack
  không có `pipeline` chạy chuỗi mặc định của engine (`plan`, `validate_ir`, `render`, `upload`,
  `finalize`); `brand-intro` đang như vậy.
- `PackPipeline.stages(job, engine)` trả danh sách stage cho một job. `PackJob.fromVersion` báo job
  render một version đã lưu (`studix_render`, feedback có patch); `PackJob.feedback` báo version đó đến
  từ feedback. Nhờ vậy một pack tách được job tạo mới (dừng ở `engine.storyboardReady` chờ người duyệt)
  khỏi job render bản đã duyệt (chạy các stage tốn tiền).
- `EngineStages` là các stage engine pack đan vào: `brief`, `plan`, `validateIr`, `render`, `upload`,
  `finalize`, `storyboardReady`. Checkpoint của chúng mang tên `brief`, `plan`, `validate_ir`, `render`,
  `upload`, `finalize`, `storyboard_ready`. Lý do dùng lại thay vì chép: version, commit có fencing,
  upload và ghi render chỉ có một chỗ.
- `irOf(s)` lấy `ir` của output mới nhất có trường đó, nên stage của pack sửa IR thì trả `{ ir }` mới
  và stage sau tự thấy.
- `PackPipeline.renderer` là id renderer mà IR của pack được viết cho. Worker có renderer khác thì job
  fail trước khi chạy stage nào.
- `PackPipeline.result` mặc định là output `finalize`, không có thì `storyboard_ready`.

### Stage

Các field của `StageDefinition` và lý do có chúng (định nghĩa đầy đủ trong `workflow-types.ts`):

| Field                        | Dùng để                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `inputSchema`                | Parse `{ payload, outputs }` thành `stage.input`; input sai bị chặn trước khi chạy hay tính phí                            |
| `outputSchema`               | Kiểm output trước khi checkpoint hoặc cache; entry cache không còn khớp bị bỏ qua và stage chạy lại                        |
| `cacheKey`                   | Danh tính công việc, thường là `stageCacheKey(name, version, input)`; chỉ khai khi output di động (không chứa path cục bộ) |
| `knowledge`                  | Id knowledge pack stage nạp ([KNOWLEDGE_PACKS.md](KNOWLEDGE_PACKS.md)); QA stage cũng dùng nó để gắn hard check            |
| `estimateCostCents`          | Ước tính để kiểm budget trước khi chạy; không khai thì ước tính là 0 nhưng job đã vượt budget vẫn bị dừng                  |
| `approval`                   | Chặn stage sau approval của người (`action`, `scopeKey`, `reason`)                                                         |
| `requiresApprovedStoryboard` | Chỉ chạy khi storyboard của project đã được người duyệt                                                                    |
| `retry`                      | `"never"`: lỗi của stage không được retry tự động                                                                          |
| `isCheckpointValid`          | Checkpoint cũ còn dùng được không (ví dụ file render cục bộ còn tồn tại)                                                   |

Runner (`runStages`) xử lý mỗi stage theo thứ tự này; thứ tự quyết định lỗi nào xuất hiện trước:

1. Checkpoint `succeeded` cùng tên, ở attempt bất kỳ, được dùng lại nếu `isCheckpointValid` không từ chối.
2. Parse `inputSchema`.
3. Kiểm storyboard nếu stage khai `requiresApprovedStoryboard`.
4. Tra stage cache theo `cacheKey`. Hit khớp `outputSchema` thì ghi checkpoint và sang stage sau: không
   gate, không kiểm budget, không tính phí.
5. Approval gate nếu stage khai `approval`.
6. Kiểm budget với `estimateCostCents`.
7. Chạy `run`. Usage được ghi vào ledger trước khi kiểm output, vì gọi trả tiền đã xảy ra.
8. Ghi checkpoint có fencing, sau đó mới đưa output vào cache, rồi so tổng chi với budget.

### StageContext

- `input`, `outputs`, `job`, `attempt`, `signal` (abort khi cancel, deadline, mất lease hay shutdown;
  `reason` là `StudixError`), `reportProgress`.
- `commit(write)`: mọi ghi nghiệp vụ (project, version, render) đi qua đây, trong transaction khóa theo
  quyền sở hữu job. Worker đã mất job nhận `LeaseLostError` và không ghi gì. Không dùng repository bắt
  lúc wiring.
- `mediaJournal`: truyền vào mọi media request (`journal`). Mỗi bản ghi lưu cùng stage row, nên attempt
  sau, trên worker nào cũng vậy, thu lại job upstream đã trả tiền theo id thay vì submit lại.
  `generateStoredMedia` tự làm việc này với idempotency key `<jobId>:<stage>:<assetId>`, nên `assetId`
  phải ổn định trong một job.
- `services`: `media`, `storage`, `renderer`, `qa`, `workRoot` do worker nối. Lấy bằng
  `requireService(s, name)`; thiếu service là `UNAVAILABLE` không retry.
- `agents`: trạng thái approval và handoff của agent stage
  ([ADR-0015](decisions/0015-agent-stage-caps-and-host-handoff.md),
  [ARCHITECTURE.md](ARCHITECTURE.md#agent-stages)).

Stage có gọi trả tiền phải báo chi phí cả khi không thành công: ném `StageFailedAfterSpend` (runner ghi
usage rồi mới fail), `StageSuspended` (park job sau khi ghi phần đã tiêu), hoặc dùng `mapBounded` với
`usageOf` và `billedOnFailure`. Usage line có `upstreamJob` hoặc `providerExecutionId` được dedupe theo
job upstream, nên một job được thu lại ở attempt sau không bị tính hai lần.

### Agent stage trong worker

Worker có `STUDIX_SECRETS_KEY` thì chạy agent stage mode `harness` ngay trong worker
([`agent-harness.ts`](../apps/worker/src/agent-harness.ts)), trên connection của chính workspace
([ADR-0016](decisions/0016-provider-connections-runtimes-and-model-preferences.md)). Runtime được chọn
theo thứ tự:

1. Job chọn Claude planner (`planner.runtime: "claude"`): Claude trên connection đó, model của planner.
2. Snapshot đã pin cho job và stage (`job_model_snapshots`): retry luôn chạy lại đúng model đó.
3. Model preference cụ thể nhất của runtime `pi` hoặc `claude` cho tên stage (thực tế là entry `default`
   của người tạo job, rồi của workspace). Hai runtime ngang hạng thì chọn Pi. Lựa chọn được pin lần đầu.

Không có lựa chọn nào thì stage fail `UNAVAILABLE`, không dùng key của operator. Claude chỉ chạy khi
worker bật `STUDIX_CLAUDE_PLANNER`. Cap của stage (turns, tokens, cost, time) được runtime ép như
[ADR-0015](decisions/0015-agent-stage-caps-and-host-handoff.md). Mỗi lần chạy, thành công hay không, ghi
một `provider_executions` (provider `anthropic` hoặc `pi`, `operation` là tên stage) với token và chi phí
thật. Usage line `agent.run` của stage trỏ tới bản ghi đó. Cả hai mang `funding` (`workspace` hoặc `member`
theo chủ connection): chi phí BYOK được ghi nhưng không tính cho workspace, và vẫn bị ngân sách job giới hạn
([ADR-0016](decisions/0016-provider-connections-runtimes-and-model-preferences.md)).

### Gate

| Gate            | Khai báo                                           | Ai mở                                                                            | Bị từ chối               |
| --------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------ |
| Approval gate   | `approval: { action, scopeKey?, reason? }`         | Approval policy quyết có cần duyệt; chỉ quyết định của người đăng nhập được tính | Stage fail `FORBIDDEN`   |
| Creative gate   | `createCreativeGateStage({ gate: "G0", summary })` | Luôn cần người: action `creative.gate`, scope `gate:<id>`                        | Stage fail `FORBIDDEN`   |
| Storyboard gate | `requiresApprovedStoryboard: true`                 | Người duyệt storyboard trên trang review của dashboard                           | `APPROVAL_REQUIRED` ngay |
| Agent overrun   | Tự có trong `createAgentStage` khi agent chạm cap  | Action `agent.overrun`, scope `agent:<stage>`                                    | Stage fail `FORBIDDEN`   |
- Gate chưa quyết thì job park ở `waiting_approval` mà không tiêu attempt; approval hết hạn thì job fail.
  Quyết định nằm trong Postgres nên không bị hỏi lại sau restart hay retry.
- Creative gate có `retry: "never"` và không có `cacheKey`: mỗi job hỏi người duyệt của nó.
- Hiện chỉ có G0 và G1 là creative gate (pack `anime`, `long-form-film`). "G3" (continuity) và "G4" (QA)
  trong mô tả pack là stage kiểm bằng máy, `<pack>.continuity` và `<pack>.qa`, không chờ người.
- Storyboard gate được kiểm trước stage cache, nên không có gì chạy hay bị tính phí khi storyboard chưa
  duyệt. Luồng review storyboard: [ARCHITECTURE.md](ARCHITECTURE.md#storyboard-review-gate).

### Retry và resume

- Executor retry một attempt fail khi cả ba điều kiện đúng: lỗi có `retryable: true`, stage không khai
  `retry: "never"`, và job còn attempt. Độ trễ theo `DEFAULT_RETRY_BACKOFF` (lũy thừa 2, có trần).
- `retryable` mặc định theo mã lỗi (`RETRYABLE_BY_DEFAULT` trong
  [`errors.ts`](../packages/shared/src/errors.ts)). Stage nên đặt `retryable: false` khi chạy lại không
  đổi được kết quả: input sai, gate bị từ chối, thiếu service.
- Dùng `retry: "never"` cho stage có tác dụng phụ mà kết quả không chắc (publish), creative gate và agent
  stage.
- Park (`waiting_approval`, `waiting_host`) và release lúc shutdown không tiêu attempt.
- Job đã `failed` được requeue bằng tay qua `studix_retry_job`: stage xong giữ checkpoint, stage fail dùng
  lại media journal ([MCP_API.md](MCP_API.md#retrying-a-failed-job)).

## Tạo workflow pack mới

1. **Đọc mẫu.** [`brand-intro`](../packages/skills/src/brand-intro/brand-intro-pack.ts) là pack nhỏ nhất
   (template, stage compose `brandIntroComposeStage` và agent stage `brandIntroScriptStage`, không
   pipeline).
   [`motion-graphic`](../packages/skills/src/motion-graphic/motion-graphic-pack.ts) có pipeline đầy đủ:
   compose, voice-over trả tiền, render, QA, upload, và nhánh `fromVersion`.
2. **Tạo thư mục** `packages/skills/src/<pack-id>/` với `<pack-id>-pack.ts` export một `WorkflowPack`.
3. **Template** (`Skill`): `id` kebab-case, `inputSchema` là JSON Schema của input (pack hiện có dùng
   `exportJsonSchemas()["creative-brief"]`), `run(input, options)` parse input ở biên và trả `VideoIR`,
   input sai ném `VALIDATION`. Planner mặc định chạy `templates[0]` của pack
   ([`video-planner.ts`](../apps/worker/src/planner/video-planner.ts)) cho job đi qua `engine.plan` mà
   chưa có version.
4. **Stage.** Đặt tên `<pack-id>.<việc>`. Khai `inputSchema` và `outputSchema` bằng zod. Chỉ khai
   `cacheKey` khi output di động, và tăng version trong key khi hành vi đổi. Khai `knowledge` đúng pack
   cần. Stage trả tiền khai `estimateCostCents` (`estimateMediaCents`) và sinh media qua
   `generateStoredMedia`. Stage tiêu tiền theo kế hoạch đã duyệt khai `requiresApprovedStoryboard`. QA gọi
   `requireService(s, "qa").assertPasses(...)` ([QA.md](QA.md#gate-cho-stage-của-pack)). Phần sáng tạo do
   agent viết dùng `createAgentStage`; mốc cần người ký dùng `createCreativeGateStage`.
5. **Pipeline.** `stages(job, engine)` đan stage của pack với `EngineStages`. Đặt `renderer` khi IR chỉ
   dành cho một renderer.
6. **Đăng ký.** Thêm pack vào mảng của `createPackRegistry` trong `skill-registry.ts` và export nó từ
   [`index.ts`](../packages/skills/src/index.ts). Pack nạp lúc chạy dùng `registerPack(pack)`. Registry
   từ chối lúc khởi động: id không phải kebab-case hoặc stage khai knowledge chưa đăng ký (`VALIDATION`),
   pack, template hay stage trùng tên (`CONFLICT`). MCP server và worker không cần sửa.
7. **Test.** Theo mẫu trong `packages/skills/test/`: `pack-registry.test.ts` (registry, stage compose),
   `pack-pipelines.test.ts` (chạy pipeline qua `createJobExecutor` với `FakeMediaProvider`, stage cache
   trong bộ nhớ và QA gate giả), `marketing-motion-templates.test.ts` (template). Hành vi engine có test
   trong `packages/workflow/test/` (`stage-cache`, `storyboard-gate`, `stage-media-journal`,
   `creative-gate-queue.integration`). Chạy `pnpm check`.
8. **Docs.** Ghi hành vi client thấy được vào mục `workflowTemplate` của [MCP_API.md](MCP_API.md); port từ
   nguồn thì cập nhật [PORTING.md](PORTING.md).

## Provider adapter

Stage không gọi SDK hay CLI của vendor. Mọi media đi qua port `MediaProvider`
([`media-provider.ts`](../packages/core/src/ports/media-provider.ts)) mà worker đưa vào
`services.media` ([ADR-0010](decisions/0010-renderer-and-media-provider-adapters.md)). Worker production
dùng `MultixProvider`; test và CI dùng `FakeMediaProvider`.

| File trong `packages/providers/src/`                                                   | Vai trò                                                                                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [`multix-provider.ts`](../packages/providers/src/multix-provider.ts)                   | `MultixProvider`: estimate, trần chi mỗi call, submit, journal, thu job; `createMultixProviderFromConfig`     |
| [`multix-cli-runner.ts`](../packages/providers/src/multix-cli-runner.ts)               | Chạy multix CLI bằng argv cố định, không shell, chỉ với env adapter cấp                                       |
| [`multix-routes.ts`](../packages/providers/src/multix-routes.ts)                       | Role sang vendor, model mặc định theo role, argv từng role, giá giả định cho route multix không định giá được |
| [`media-request-guards.ts`](../packages/providers/src/media-request-guards.ts)         | Kiểm biên: kind, độ dài prompt, giá trị param vào argv, file input phải nằm trong `workDir` hoặc là URL https |
| [`media-job-journal.ts`](../packages/providers/src/media-job-journal.ts)               | Contract journal (từ `@studix/core`) và journal trong process, chỉ dùng khi request không mang journal        |
| [`media-price-book.ts`](../packages/providers/src/media-price-book.ts)                 | Giá đã đo hoặc đã chấp nhận theo model, đơn vị tính của một request                                           |
| [`media-batch-probe-policy.ts`](../packages/providers/src/media-batch-probe-policy.ts) | `runMediaBatchWithProbe`: model chưa có giá chạy một job probe, đo giá, rồi mới chạy phần còn lại của batch   |
| [`fake-media-provider.ts`](../packages/providers/src/fake-media-provider.ts)           | Provider giả cho test và CI, không tốn tiền                                                                   |

Bảng route (role nào chạy ở vendor nào, model mặc định) là `MULTIX_ROLE_VENDORS` và
`DEFAULT_MULTIX_MODELS` trong `multix-routes.ts`. Cách bật adapter, key của từng vendor và biến chọn model
nằm ở [DEPLOYMENT.md](DEPLOYMENT.md#configuration). Không bật thì mọi stage trả tiền fail `UNAVAILABLE`.

Lý do của các ràng buộc:

- **Estimate rồi mới gọi.** Request mang `maxCostCents`; provider từ chối thay vì vượt trần, nên một prompt
  hay model đắt không tự tiêu quá budget. Ảnh Sume chạy với `--cost-policy estimate`: request không chọn
  resolution thì catalog khớp nhiều mức giá (1K/2K/4K), multix chỉ chặn được bằng giá cao nhất và gọi đó là
  ước tính; giá cao nhất này vẫn là trần thật cho số ảnh đã xin, nên được nhận nếu không vượt `maxCostCents`.
  multix chỉ định giá Sume từ catalog đã cache (`~/.multix/cache`, hết hạn sau 24h); worker mới chưa có cache
  thì adapter chạy `sume models --refresh` một lần (tối đa một lần mỗi phút) rồi định giá lại.
- **Journal trước khi tin vào kết quả.** Job bất đồng bộ được ghi vào journal ngay sau khi submit; retry
  thu job theo id. Atlas Cloud không có idempotency key, nên adapter ghi trạng thái `submitting` ngay
  trước khi gửi; bản ghi `submitting` không có job id thì không gửi lại (có thể đã bị tính tiền).
- **Phí của call fail vẫn được ghi.** Provider ném `MediaChargedError` khi upstream đã tính tiền nhưng kết
  quả không dùng được; `generateStoredMedia` chuyển nó thành `StageFailedAfterSpend`.
- **Probe trước batch.** `runMediaBatchWithProbe` là policy của package; hiện chưa stage nào của pack gọi nó.

### Audio

- TTS, nhạc và SFX là các `MediaKind` `voice`, `music`, `sfx`, đi qua `MultixProvider`. Kind `audio`
  chung bị từ chối, phải chọn một trong ba.
- Ba role này chạy đồng bộ, không có job upstream để resume. Provider ghi file vào thư mục media của job
  (`stageMediaDir`, `<workRoot>/<jobId>/media/<stage>`), không phải work dir của attempt, nên stage được
  retry tìm lại file đã trả tiền thay vì sinh lại. Thư mục bị xóa ở `finalize`; job fail giữ nó cho lần
  retry. Retry chạy trên worker khác (không thấy thư mục đó) thì vẫn sinh và trả tiền lại.
- Pack dùng: `marketing-video.audio` (voice, music, sfx), `motion-graphic.voiceover` (một SFX accent ở card CTA và một
  whoosh ngắn sinh một lần, đặt ở mọi lần cắt còn lại; bỏ qua kèm `warning` khi lời gọi trả `UNAVAILABLE`; lời
  gọi dùng cả key của workspace), `motion-graphic.voice` (voice), `motion-graphic.music` (music, bỏ qua kèm `warning` khi thiếu
  provider/key),
  `<film-pack>.dialogue` (voice) và `<film-pack>.score` (music, sfx).
- Trộn, loudness và delivery do renderer làm bằng FFmpeg: [RENDERER.md](RENDERER.md).

### Atlas

Atlas là Atlas Cloud, một vendor của multix (`atlas` trong `MULTIX_VENDORS`). Trong code nó chỉ phục vụ
role `imageUpscale` (kind `upscale` với `params.image`). Chưa có stage nào của pack gửi request
`upscale`, nên route này có sẵn ở adapter nhưng chưa pack nào dùng.

### Thêm provider

Implement `MediaProvider` (`capabilities`, `estimateCostCents`, `generate`, tùy chọn `resume`), tôn trọng
`maxCostCents` và `journal` của request, chỉ báo kind đã nối đầu cuối, và có test riêng như
`packages/providers/test/multix-provider.test.ts`. Worker nhận provider qua `pack-services.ts`.

## Prompt mẫu

Ba input dưới đây là argument của MCP tool `studix_create_video`
([MCP_API.md](MCP_API.md#p0-native-tools)). Chúng đã được parse bằng `CreateVideoProjectInput` và chạy
qua template của pack trên code hiện tại. Schema chuẩn của `brief` là `creative-brief.schema.json` trong
[`packages/video-ir/schemas/`](../packages/video-ir/schemas/creative-brief.schema.json); `studix_inspect`
với `include: ["schemas"]` trả cùng schema. Thương hiệu trong mẫu là bịa.

`budgetCents` ở dưới ngưỡng duyệt mặc định; vượt ngưỡng thì job bắt đầu ở `waiting_approval` chờ approval
`job.start`. Mức thật của một pack phụ thuộc giá model; xem [METRICS.md](METRICS.md).

### marketing-video

Mỗi phần tử của `brief.directions` (1 đến 6) thành một quảng cáo. Brief không có direction thì pack tự
dựng một quảng cáo từ chính brief: `keyMessages[0]` (hoặc `brand.name` khi không có key message) làm hook,
hai key message kế tiếp làm thông điệp (beat dựng sẵn chỉ chứa tối đa hai, phần dư bị bỏ), prompt làm
concept. Prompt không bao giờ được đọc thành lời vì nó là
yêu cầu gửi Studix. Brief không có direction, key message lẫn brand name bị từ chối `VALIDATION` ngay lúc
tạo job (`studix_create_video` hoặc dashboard), trước khi có project hay job nào. Form tạo video trên
dashboard có ô key message (bắt buộc với pack này) và call to action.
Voice-over mỗi quảng cáo phải vừa ngân sách từ theo độ dài (khoảng ba từ
mỗi giây, `voiceoverWordBudget` trong
[`marketing-script.ts`](../packages/skills/src/marketing-video/marketing-script.ts)). Độ dài đọc đo bằng
`spokenLength` ([`caption-chunks.ts`](../packages/skills/src/caption-chunks.ts)): mỗi âm tiết tiếng Việt là
một từ, còn từ tiếng Anh hay tên thương hiệu tính theo số âm tiết, mỗi âm tiết khoảng hai phần ba từ
("AI-native" khoảng ba từ; số đọc theo hàng, "99.000đ" khoảng năm từ; ngày "12.12" là hai số; số điện
thoại như "0901 234 567" hay "0901.234.567" đọc từng chữ số; "2024-2025" là hai năm). `motion-graphic` chia thời lượng card theo độ dài này.
Phụ đề burn-in (`captionCues`) chia mỗi lời đọc thành cue tối đa chín từ, ưu tiên ngắt ở dấu câu, và tránh
cue chỉ có một từ. Khi cách chia đó có cue ngắn hơn 600 ms (`MIN_CAPTION_MS`) hay cắt đôi một số điện thoại,
dòng được cắt lại: cue ngắn nhất dài nhất có thể, không cue một từ, số điện thoại trọn trong một cue, rồi ít
cue nhất.
Số beat của storyboard agent theo độ dài video (`motionBeatRange`): khoảng một beat mỗi 5 s, từ 3 đến 12
(60 s là 12, chấp nhận 9 đến 12; dưới khoảng 17,5 s vẫn 3 đến 6), để video dài có nhiều card hơn thay vì
giữ mỗi card lâu hơn. Storyboard sai số beat được một lượt sửa như dưới (cùng mọi lỗi khác trong một thông
điệp); sau lượt sửa, hay ở `agentMode: "host"`, số beat chỉ là khuyến nghị: storyboard có lời đọc vừa vẫn
được giữ, vì template (không agent) tối đa sáu card;
storyboard của agent mà tổng thời lượng các card cần (làm tròn lên 100 ms) dài hơn video thì được gửi lại
cho agent đúng một lượt sửa (kèm lỗi cụ thể: dòng nào, phòng bao nhiêu ms, nên cắt còn bao nhiêu từ; chạy trong
`MG_STORYBOARD_LIMITS` và ngân sách job, cả hai lượt đều ghi usage `agent.run`; agent chạy ở `agentMode: "host"`
không có lượt sửa). Chỉ khi lượt sửa vẫn không vừa mới quay về template và ghi lý do ở `fallbackReason`. Còn beat do `directions[0].beats` đưa vào thì fail `VALIDATION`.
`marketing-video` từ chối ngay ở stage script (trước clip trả phí) câu nào dài hơn beat của nó chứa được, kể cả khi đọc nhanh tới 1.12×. Bản đọc dài hơn beat được xử lý như ở
`motion-graphic`: cắt kèm fade nếu dư tới 250 ms, đọc nhanh lên tới 1.12× nếu dài hơn, quá mức đó mới fail.

```json
{
  "workflowTemplate": "marketing-video",
  "title": "Lá Mây - hai hướng quảng cáo",
  "brief": {
    "prompt": "Hai quảng cáo dọc 20 giây cho tiệm trà sữa Lá Mây",
    "language": "vi",
    "objective": "promotion",
    "aspectRatio": "9:16",
    "durationMs": 20000,
    "callToAction": "Đặt trà ngay hôm nay",
    "keyMessages": ["Trà ủ lạnh mỗi sáng", "Ít ngọt, nhiều vị trà"],
    "directions": [
      {
        "id": "morning-ritual",
        "name": "Nghi thức buổi sáng",
        "concept": "Một ly trà ủ lạnh trên bàn làm việc gần cửa sổ, nắng sớm và hơi nước đọng trên ly",
        "hook": "Sáng nay bạn uống gì?"
      },
      {
        "id": "after-class",
        "name": "Sau giờ học",
        "concept": "Nhóm bạn sinh viên chia nhau những ly trà sữa trên bậc thềm thư viện lúc chiều muộn",
        "hook": "Tan học rồi, ghé Lá Mây"
      }
    ]
  },
  "idempotencyKey": "la-may-ads-001",
  "budgetCents": 800
}
```

Job này dừng ở storyboard (`in_review`). Sau khi người duyệt storyboard, gọi `studix_render` để chạy
image-to-video, audio, render, QA và publish.

### motion-graphic

Prompt trơn cũng chạy được: template lấy hook từ `title` hoặc prompt. Brief không có `brand` thì agent
storyboard trả `brandName` đúng như brief viết (ví dụ "Studix" trong "introducing Studix"); tên đó làm tên
brand kit, `title` của IR (khi brief không có `title`) và chữ logo ở card CTA. Tên không xuất hiện trong brief
bị bỏ qua; không có tên nào thì card CTA không hiện tên brand thay vì lặp lại câu hook. Style profile được chọn theo
`tone`, `objective` và prompt, hoặc theo `directions[0].visualStyle` nếu trùng id một profile trong
[`motion-style-profiles.ts`](../packages/skills/src/motion-graphic/motion-style-profiles.ts). Voice-over
template tự lấy từ brief (hook, tối đa bốn message, CTA) được co cho vừa ngân sách từ của độ dài: bỏ message
từ cuối lên, rồi cắt bớt lời đọc của dòng dài nhất, tới khi mọi card đủ thời gian đọc câu của nó. Card hook, card CTA và chữ trên màn hình vẫn được giữ,
nhưng lời đọc của chúng có thể bị cắt bớt, CTA sau cùng. Beat do
`directions[0].beats` đưa vào mà quá dài thì vẫn fail `VALIDATION`. `"voiceover": false` cho video không
lời (chỉ chữ trên màn hình, không caption, không SFX accent, không cần provider giọng); `marketing-video`
cũng tôn trọng field này. Thiếu model hay key SFX/nhạc thì SFX accent và music bed bị bỏ qua, stage ghi `warning`, job vẫn
chạy tiếp. Bản đọc được đo bằng FFmpeg `silencedetect`: khoảng lặng đầu bị bỏ qua (`trimStartMs`, giữ
60 ms trước tiếng đầu), khoảng lặng cuối không tính, chỉ phần lời phải vừa beat. Lời dài hơn beat thì được
đọc nhanh lên (giữ cao độ, `playbackRate` của audio track) tới 1.12×; quá mức đó thì dòng được đọc lại một
lần với chỉ dẫn đọc gọn hơn (tính tiền cả hai lần đọc, bản dài không được lưu hay tái dùng); bản đọc lại vẫn
quá dài mới fail `VALIDATION`. Ước tính chi phí vẫn tính một lần đọc mỗi dòng. File không đo được (không có
FFmpeg) thì cả file được tính, dư tới 250 ms (hơi thở cuối) thì cắt kèm fade.

```json
{
  "workflowTemplate": "motion-graphic",
  "brief": {
    "prompt": "Motion graphic dọc 15 giây giới thiệu gói cà phê giao hằng tuần của Sương Mai",
    "title": "Cà phê tươi mỗi tuần",
    "language": "vi",
    "objective": "launch",
    "tone": ["năng động", "ấm áp"],
    "keyMessages": ["Rang mộc mỗi sáng", "Giao tận nhà mỗi thứ Hai", "Huỷ bất cứ lúc nào"],
    "callToAction": "Đăng ký ngay hôm nay",
    "aspectRatio": "9:16",
    "durationMs": 15000
  },
  "idempotencyKey": "suong-mai-mg-001",
  "budgetCents": 300
}
```

### anime

Brief chỉ là đầu vào cho agent viết scope (series bible và beat sheet); luật tier và độ dài shot áp lên
scope đó trước G0 ([`anime-pack.ts`](../packages/skills/src/narrative-film/anime-pack.ts)). Ở mode
`harness` (mặc định) worker tự chạy agent bằng key và model của workspace (xem
[Agent stage trong worker](#agent-stage-trong-worker)). Với `agentMode: "host"`, agent của MCP client nhận
task qua các tool handoff ([MCP_API.md](MCP_API.md#agent-stage-handoff-tools)). Job dừng ở G0 và G1 chờ
người ký trên dashboard.

```json
{
  "workflowTemplate": "anime",
  "agentMode": "host",
  "brief": {
    "prompt": "Một cảnh anime 15 giây: cô bé giao thư đạp xe qua con dốc ven biển lúc hoàng hôn, dừng lại nhặt lá thư bị gió thổi bay và nói một câu với chú mèo đi theo",
    "title": "Lá thư trên dốc gió",
    "language": "vi",
    "tone": ["ấm áp", "hoài niệm"],
    "aspectRatio": "16:9",
    "durationMs": 15000,
    "constraints": ["Nhân vật và bối cảnh là nguyên bản, không mô phỏng phim hay studio có thật"]
  },
  "idempotencyKey": "la-thu-doc-gio-001",
  "budgetCents": 900
}
```

Script smoke [`smoke-video.ts`](../apps/mcp-server/scripts/smoke-video.ts) chỉ gọi pack mặc định
(`brand-intro`) với một prompt; nó không thay cho ba mẫu trên.

## Pack `skill-agent`

Agent của job (Claude Code, Pi hoặc Codex) tự dựng và render video trong skill sandbox, theo đúng
SKILL.md của skill được bật. Studix chỉ đặt contract đầu ra (1080p, thời lượng ±0.5 s, có voice-over,
-16 LUFS ±2, true peak ≤ -1 dBTP) và kiểm lại file trước khi lưu; file sai contract làm job lỗi
`VALIDATION`. Cần `STUDIX_SANDBOX=docker`. Stage chỉ giữ trước tối đa phần budget còn lại của job (cap 800¢), nên
budget nhỏ hơn chỉ giới hạn lượt chạy chứ không làm job fail. Deadline mặc định là 60 phút, tính từ lúc worker
nhận job. Model không có vision được gợi ý soát khung hình bằng `multix gemini analyze` khi sandbox có
`GEMINI_API_KEY`. Quyết định ở
[ADR-0022](decisions/0022-agentic-video-authoring.md).

## Giới hạn của QA gate

Stage `<pack>.qa` chỉ đo thông số kỹ thuật của file render và không chấm thẩm mỹ. Phạm vi và giới hạn
của nó ở [QA.md](QA.md#sandbox-và-giới-hạn).

## Xử lý lỗi thường gặp

Mã lỗi và thông điệp dưới đây lấy từ code; `error.details` và `error.suggestedAction` của job mang phần
còn lại. Bảng chung cho client: [MCP_API.md](MCP_API.md#troubleshooting).

| Triệu chứng                                                                                                       | Nguyên nhân                                                                                                                   | Xử lý                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `VALIDATION` "Unknown workflowTemplate ..." khi gọi `studix_create_video`                                         | Id không có trong registry; `details.available` liệt kê id đã đăng ký                                                         | Dùng một id trong danh sách; pack mới phải được đăng ký ở `skill-registry.ts`                                                        |
| Job `failed` với `VALIDATION` "Unknown workflowTemplate ..."                                                      | Project được tạo với pack mà registry của worker không có (`packPipelines`), ví dụ app và worker chạy hai phiên bản khác nhau | Deploy cùng phiên bản cho app và worker                                                                                              |
| `VALIDATION` "Invalid input for stage ..."                                                                        | `inputSchema` không parse được `{ payload, outputs }`; `details.issues` chỉ field                                             | Sửa payload, hoặc stage trước không tạo output stage này cần (thứ tự pipeline sai)                                                   |
| `VALIDATION` "A marketing-video brief needs creative directions or key messages"                                  | Gửi prompt trơn cho `marketing-video`                                                                                         | Gửi `brief.keyMessages` hoặc `brief.directions` như [mẫu](#marketing-video)                                                          |
| `VALIDATION` "Voice-over is longer than a ...s ad can hold" (hoặc "graphic")                                      | Voice-over vượt ngân sách từ; `details.wordBudget`                                                                            | Rút gọn hook, message, CTA hoặc tăng `durationMs`                                                                                    |
| `APPROVAL_REQUIRED` "Stage ... needs an approved storyboard"                                                      | Stage có `requiresApprovedStoryboard` chạy khi storyboard chưa `approved`; `details.storyboardStatus`                         | Thành viên workspace duyệt storyboard trên trang review, rồi gọi `studix_render`                                                     |
| `APPROVAL_REQUIRED` "G<n> needs a person's approval"                                                              | Approval policy miễn `creative.gate`, cấu hình sai                                                                            | Giữ `creative.gate` trong nhóm luôn cần duyệt của policy                                                                             |
| `FORBIDDEN` "... was rejected by a reviewer"                                                                      | Người duyệt từ chối gate; `details.comment`                                                                                   | Xử lý góp ý, tạo job mới                                                                                                             |
| `UNAVAILABLE` "Stage needs the ... service, which this worker lacks"                                              | `requireService`: worker không nối service đó                                                                                 | Nối service trong worker ([DEPLOYMENT.md](DEPLOYMENT.md#configuration))                                                              |
| `UNAVAILABLE` "The Multix provider is not configured"                                                             | Stage trả tiền chạy trên worker chưa bật multix                                                                               | Bật multix cho worker theo [DEPLOYMENT.md](DEPLOYMENT.md#configuration)                                                              |
| `UNAVAILABLE` "This worker runs no agent harness"                                                                 | Agent stage chạy mode `harness` trên worker không có `STUDIX_SECRETS_KEY` (không có harness)                                  | Tạo job với `agentMode: "host"` và hoàn tất task từ MCP client                                                                       |
| `UNAVAILABLE` "No model is configured for agent stage ..."                                                        | Workspace và người tạo job chưa chọn model mặc định cho runtime `pi` hay `claude`                                             | Chọn model mặc định trong Settings → AI & Providers, hoặc dùng `agentMode: "host"`                                                   |
| `UNAVAILABLE` "Agent stage ... resolved to Claude, which this worker does not run"                                | Lựa chọn của job là Claude nhưng worker không bật `STUDIX_CLAUDE_PLANNER`                                                     | Chọn model Pi, hoặc bật Claude runtime trên worker                                                                                   |
| `UNAVAILABLE` "Workflow ... renders with ...; this worker has ..."                                                | `PackPipeline.renderer` khác renderer của worker                                                                              | Chạy pack trên worker có đúng renderer                                                                                               |
| `VALIDATION` "Renderer ... cannot render this video"                                                              | `supports()` của renderer từ chối IR; `details.reasons`                                                                       | Sửa IR theo lý do, xem [RENDERER.md](RENDERER.md)                                                                                    |
| `VALIDATION` "Stage ... returned an output that fails its schema"                                                 | Output của `run` không khớp `outputSchema`                                                                                    | Lỗi code của stage; sửa stage                                                                                                        |
| `VALIDATION` "Agent output of stage ... fails its schema"                                                         | Agent (harness hoặc host) trả output sai schema; usage của lần chạy vẫn được ghi                                              | Tạo job mới; ở host mode, kiểm output với `outputSchema` của task trước khi nộp                                                      |
| Stage có `cacheKey` chạy lại dù input không đổi                                                                   | Entry cache không còn khớp `outputSchema` (schema đổi) nên bị bỏ qua; đây là hành vi đúng                                     | Tăng version trong `cacheKey` khi đổi schema để key cũ không bị tra                                                                  |
| `BUDGET_EXCEEDED` "... would bring job spend to ...¢, over the ...¢ budget"                                       | Ước tính của stage cộng phần đã tiêu vượt `budgetCents`                                                                       | Tăng `budgetCents` hoặc giảm phạm vi, tạo job mới                                                                                    |
| `BUDGET_EXCEEDED` "job spent ...¢, over its ...¢ budget, after ..."                                               | Chi thật của stage vượt ước tính và vượt budget                                                                               | Như trên; kiểm `estimateCostCents` của stage có sát giá thật không                                                                   |
| `BUDGET_EXCEEDED` "... estimates ... cents, above the ... cent cap"                                               | Provider ước tính một call vượt `maxCostCents` của request                                                                    | Chọn model rẻ hơn hoặc nâng trần của stage                                                                                           |
| Log worker "a stage write was refused, job lease lost" hoặc "lease could not be renewed in time"                  | Worker mất lease (heartbeat chậm, DB gián đoạn); worker khác nhận job, attempt cũ không ghi gì thêm                           | Không cần làm gì nếu job tiếp tục; lặp lại thì xem log worker theo [runbook](DEPLOYMENT.md#runbook)                                  |
| `INTERNAL` "Worker lease expired on the last allowed attempt ..."                                                 | Lease hết hạn ở attempt cuối, worker có thể đã crash                                                                          | Xem log worker của job, rồi `studix_retry_job` hoặc tạo job mới                                                                      |
| `PROVIDER_ERROR` "A previous submission of this request may already have been charged and cannot be deduplicated" | Journal có bản ghi `submitting` không có job id (upstream không dedupe được, ví dụ Atlas)                                     | Tìm prediction trong `multix history` hoặc console Atlas, gắn bằng `studix_attach_media_job`, rồi `studix_retry_job`; không retry mù |
| `CONFLICT` "This idempotency key already ran a different media request"                                           | Cùng idempotency key (`assetId` trong một stage) đi với kind hoặc model khác, kể cả khi model mặc định đổi giữa hai attempt   | Giữ `assetId` duy nhất cho mỗi asset trong stage                                                                                     |
| Retry tính tiền audio lần nữa                                                                                     | Voice, music, SFX chạy đồng bộ; file chỉ được dùng lại khi retry chạy trên cùng worker và cùng `workRoot` ([Audio](#audio))   | Giữ `workRoot` bền qua restart; chấp nhận chi lại khi job chuyển worker                                                              |
| `TIMEOUT` "Job deadline reached"                                                                                  | Hết deadline của job (thời gian park không tính)                                                                              | Tạo job với `deadlineSeconds` dài hơn hoặc video ngắn hơn                                                                            |
| QA stage fail `VALIDATION` "QA hard gate failed: ..."                                                             | File render trượt hard check; `details.failures`                                                                              | Xem [QA.md](QA.md)                                                                                                                   |
