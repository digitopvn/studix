# 0015. Agent stage: cap cứng trong harness và handoff cho host agent

- Status: Accepted
- Date: 2026-10-31

## Context

Issue [#46](https://github.com/digitopvn/studix/issues/46) cần một creative stage
của pack (script, storyboard) chạy được theo hai cách mà vẫn cùng một contract:

- Trong worker, bằng agent runtime của Studix (Claude Agent SDK theo
  [ADR 0011](0011-claude-agent-runtime-and-provider-auth.md); Pi chưa có).
- Trên agent của chính MCP client (Claude Code, Claude Desktop...), để Studix
  không trả tiền model cho phần việc host làm được.

Trước thay đổi này, `createBoundedAgentRuntime` dùng `Promise.race` với deadline.
Promise thua cuộc vẫn chạy tiếp, nên subprocess agent không bị dừng khi hết giờ.
Cap token không tồn tại. Một run vượt cap chỉ trả lỗi, và không ai được hỏi có
cho chạy tiếp hay không.

## Decision

1. **Một contract, hai mode.** `createAgentStage` (`packages/workflow`) dựng một
   `StageDefinition` từ input schema, output schema (zod), instructions và limits
   `{maxTurns, maxTokens, maxCostCents, timeoutMs}` cùng allowlist tool.
   `payload.agentMode` chọn mode: `harness` (mặc định) hoặc `host`. Output của cả
   hai mode đều được kiểm bằng cùng output schema, và cache key không phụ thuộc mode.
2. **Cap cứng trong harness.**
   - Runtime kiểm cap turns, tokens và cost mỗi lần agent báo usage, không đợi đến
     kết quả cuối. Cap time do deadline của task đặt.
   - Vượt cap thì abort session. Runtime chỉ trả về sau khi agent loop đã dừng.
     Claude runtime interrupt, rồi kill tiến trình con theo handle nếu nó không
     thoát. Loop không dừng trong `stopGraceMs` bị báo `INTERNAL`, không bao giờ
     được coi là dừng sạch.
   - Lỗi mang `details.cap` (`turns`, `tokens`, `cost`, `time`) và phần đã tiêu
     (`details.spent`).
   - Tool ngoài allowlist bị từ chối. Output được `redactDeep` trước khi rời runtime.
3. **Vượt cap thì xin duyệt, không fail im lặng.**
   - Stage ghi lại phần đã tiêu, để stage row ở `pending` và park job vào
     `waiting_approval`, kèm approval `agent.overrun` scope `agent:<stage>`.
     Action này nằm trong `ALWAYS_REQUIRED`, nên policy không tự duyệt được.
   - Mỗi approval do người duyệt cho thêm một lần chạy, với mọi limit nhân 2^n
     (n là số approval đã được duyệt hoặc đã tiêu). Approval được tiêu (fenced)
     ngay khi lần chạy bắt đầu.
   - Bị từ chối thì stage fail `FORBIDDEN`. Approval hết hạn thì job fail như
     một gate bình thường.
   - Riêng cap cost bị hạ xuống vì ngân sách job còn lại thì fail
     `BUDGET_EXCEEDED`, vì tăng gấp đôi cap không giúp gì.
4. **Handoff cho host qua MCP.**
   - Stage mở một task trong bảng `agent_handoffs` gắn với attempt hiện tại.
     Mỗi (job, stage) có tối đa một task `pending`; task của attempt cũ bị
     `cancelled`. Sau đó job park ở `waiting_host` mà không tiêu attempt.
   - Host dùng `studix_list_agent_tasks`, `studix_get_agent_task` và
     `studix_submit_agent_task` ([MCP_API.md](../MCP_API.md#agent-stage-handoff-tools)).
   - Output được kiểm bằng output schema của stage, lấy từ pack registry, rồi
     được redact. Sau đó, trong một transaction, output chỉ được nhận khi task
     còn `pending` và chưa hết hạn, `attempt` khớp, và job đang `waiting_host`
     với `attempts = attempt - 1`. Job được đưa lại `queued` trong chính
     transaction đó.
   - Nộp lại cùng digest là no-op (`replayed: true`); output khác bị `CONFLICT`.
   - Ở host mode chỉ time được ép, qua `expiresAt`. Sweeper của worker
     (`expireHostHandoffs`) đánh dấu task `expired` và requeue job. Stage khi đó
     xin `agent.overrun` với cap `time`. Các limit còn lại được gửi cho host làm
     ngân sách tham khảo.
5. **Ledger tách riêng.**
   - Agent run ghi usage kind `agent.run`. Quantity là token. Metadata gồm mode,
     runtime, model, input/output tokens, turns, round và cap; stage runner thêm
     stage và attempt.
   - Host mode ghi cost 0. `splitJobUsage` tách chi phí agent (theo stage,
     attempt, mode) khỏi chi phí media.

## Consequences

- Một pack có thể cho host agent làm phần sáng tạo mà không đổi stage hay schema.
  Worker không cần Anthropic key cho các job chạy ở host mode.
- Job có thêm trạng thái `waiting_host`. Client poll `studix_get_job` nhận
  `next[]` trỏ tới `studix_list_agent_tasks`.
- Approval `agent.overrun` dùng scope key không rỗng, nên các sweeper gate
  (`failExpiredApprovals`) tính cả scope `agent:%`.
- Ở host mode Studix không ép được turns, tokens hay cost. Studix không trả các
  chi phí đó; host tự chịu.
- Worker chỉ chạy harness khi được wire `agentRuntimeFor`. Không có runtime thì
  stage ở mode harness fail `UNAVAILABLE` và gợi ý chuyển sang host mode.

## Alternatives considered

- **Giữ `Promise.race` và chỉ báo lỗi.** Bị loại: subprocess vẫn chạy và tiêu tiền
  sau khi job đã báo dừng.
- **Fail job khi vượt cap.** Bị loại: issue yêu cầu chuyển qua human approval sẵn
  có. Người duyệt mới biết lần chạy thêm có đáng tiền không.
- **Host gửi output qua `studix_create_video` với `spec`.** Chỉ bỏ qua được cả bước
  planning, không áp được cho một stage giữa workflow, và không có fencing theo attempt.
- **Ép đủ cap ở host mode.** Không làm được: Studix không quan sát được agent của host.
