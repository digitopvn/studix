# Handoff: vòng cải tiến chất lượng Studix (B) để bằng hoặc hơn video A

Ngày 2026-11-12, 11:08. Tạm dừng để restart máy.

## Mục tiêu

Video motion-graphic tạo qua Studix MCP (B) phải đạt chất lượng tương đương hoặc hơn bản A làm bằng skill `ak-motion-video`. Vòng lặp: cải tiến, deploy, dogfood, QA, lặp lại.

## Tham chiếu

- Báo cáo A và B: `plans/reports/dogfood-261111-1824-studix-intro-video-a-vs-b.md`. Đã commit 8ea1785 trên branch worktree `fix/voice-overrun-retime`, chưa push.
- Video:
  - A v2: `/Volumes/GOON/claude/studix/dogfood-videos/video-a-v2/renders/studix-intro-v2.mp4`
  - B mới nhất: `/Volumes/GOON/claude/studix/dogfood-videos/video-b-r5/b-r5.mp4`
- Prompt dùng cho B: copy từ job `dogfood-b-r4-261111` (trong báo cáo). Gọi `studix_create_video` với `workflowTemplate: motion-graphic`, `renderPreset: final`, `budgetCents: 900`.

## Issue cải tiến (mở 2026-11-12)

| Issue | Nội dung | Trạng thái |
|---|---|---|
| #433 | Cắt theo beat nhạc, reveal theo từ, duck nhạc | Merged: #439 vào main, #443 vào dev |
| #434 | Camera, chiều sâu, match cut | Merged dev: #447, sửa thêm #450 |
| #435 | Vòng QA hình ảnh, critique bằng vision | Merged dev: #438 |
| #436 | UI kit sản phẩm, brand kit | Merged dev: #441. PR #453 (hardening) đang mở |
| #437 | Style profile, director premium | PR #448 và #454 đang mở vào dev, có vẻ trùng nhau |

Các PR trên do pipeline cloud tự động (branch `claude/bold-newton-*`, label `ai-handle`) làm. Subagent local của phiên này đã dừng để tránh làm trùng.

Branch local bỏ dở: `feat/motion-graphic-beat-sync` (c6edf4d, worktree `agent-aca7f13c8c2edf5a0`) có các điểm khác với #439:
- snap trong ±1 beat;
- duck −5 dB;
- đặt drop đúng card chốt.

Chưa quyết định dùng hay bỏ.

## Trạng thái deploy

- `dev` đi trước `main` khoảng 95 commit. Deploy dev cho 196473d đang chạy lúc dừng.
- Prod (`main`) chưa có camera, QA hình ảnh, UI kit; chỉ có #439 (beat sync).

## Bước tiếp theo

1. Kiểm tra deploy dev xanh: `gh run list -R digitopvn/studix --branch dev -L 3`.
2. Chờ hoặc xử lý #448, #453, #454: chọn một trong #448 và #454.
3. Dogfood trên dev nếu có quyền key dev. `ak secrets` hiện từ chối vì binary claude chưa pin: cần user chạy lại grant cho `STUDIX_DEV_API_KEY`. Lệnh:

   ```
   STUDIX_MCP_URL=https://dev-app.studix.digitop.ai/mcp ak secrets run --env STUDIX_API_KEY=STUDIX_DEV_API_KEY -- node plans/261109-1823-pi-agent-routing/tools/studix-mcp-prod.mjs <tool> <args.json>
   ```

   Nếu không có quyền dev, mở PR release `dev` → `main`, merge, theo dõi deploy prod, rồi dogfood bằng connector MCP prod.
4. Chạy B vòng 6, so sánh với A v2. Mở issue `ai-handle` cho mỗi khoảng cách còn lại, lặp lại.
5. Commit hoặc push báo cáo.

## Lưu ý vận hành

- CI job "QA speech tests" đỏ vì hạ tầng (apt mirror, checksum ffmpeg). Xem #426. Đã merge bỏ qua job này cho #414, #422, #432.
- Không còn tiến trình nền nào của phiên này đang chạy.
