# Rà soát issue mở của studix (2026-11-11)

23 issue mở. Đối chiếu với PR đã merge vào `dev`/`main` và các PR draft đang mở.

## Nên đóng

| Issue | Lý do |
|---|---|
| #5 HyperFrames handleSIGTERM | Bản vá đã ở `dev`/`main` (`patches/@hyperframes__engine@0.8.223.patch` có `handleSIGTERM`, kèm test). |
| #329 Create-time check job không có agent | Đã gắn `done`; #328 + release #330 đã ship kiểm tra lúc tạo job cho Pi. PR #331 đóng không merge, vì vậy cần thử lại nhanh với workspace API key trước khi đóng. |
| #285 Asset roles/folders | Gắn `done` nhưng #286 và #288 (trùng nhau, cùng migration 0034) **chưa merge**. Không đóng; đóng một trong hai PR (giữ #288) rồi merge. |
| #293 Logs hardening | Gắn `done` nhưng #294/#295 chưa merge. Không đóng; bỏ nhãn `done`. |

Dọn PR trùng/cũ (không phải issue, nhưng là nguồn rối): #299/#301 (đã có #300), #314 (đã có #315), #318 (đã có #320), #256/#258/#259/#260/#261/#263 (đã thay bằng #257, #264, #270, #275), #251/#252 (đã có #253), #360/#361 trùng nhau, #291/#292 trùng nhau, #294/#295 trùng nhau.

## Ưu tiên xử lý

**P0, làm ngay**
1. #362 SISF 42s → 5s: validate delivery/audio trước khi chạy Pi, gate QA, giới hạn số turn. Lỗi mất tiền và giao kết quả sai mà vẫn PASS.
2. #351 Dogfood P0/P1 (issue cha của #362): review MCP Apps, minh bạch model override, chất lượng/chi phí motion-video.
3. #357 Prod worker thêm slot thứ hai: chỉ cần operator đổi env trên TOSE (`WORKER_CONCURRENCY=2`, `STUDIX_SANDBOX_RUNNERS=2`). Rẻ, gỡ tắc hàng đợi ngay.
4. #359 Task-first execution, MCP response gọn: đang review; chọn một trong #360/#361 rồi merge.

**P1, tiền và độ tin cậy**
5. #189 QA hard gate cho qua mọi render owner từ chối. Cùng gốc với #362, nên làm chung.
6. #187 Ledger ghi giá niêm yết thay vì chi phí thực. Sai số liệu billing.
7. #117 Mất chi phí của media call đang chạy khi cancel/abort.
8. #213 Audio đồng bộ có thể bị trả tiền hai lần (prod không có volume).
9. #190 Restart worker bỏ dở attempt render (time-to-preview 809 s).
10. #302 Báo agent trước khi hết wall time, giữ lại `/work/out`. Liên quan đến lỗi turn vô hạn ở #362.

**P2, tính năng đang dở**
11. #285 → #283 → #284 asset: merge #288, rồi #287 (phần Manage), rồi tab Assets trên dashboard.
12. #290 / #293 logs: merge #292 → #294; phần còn lại bị chặn bởi TOSE #545.
13. #310 Render 1080p30 chỉ ~0.4 fps: cần benchmark trên TOSE; trước mắt tăng CPU runner.
14. #167 Integration test flaky dưới tải: ảnh hưởng tốc độ CI.

**P3, backlog**
15. #188 ghi lại các lần owner từ chối, #192 runMediaBatchWithProbe/Atlas upscale, #248 kích hoạt skill phase 2, #58 Footage intelligence. #58 đã mở từ 2026-10-31 mà không có hoạt động; cân nhắc đóng vì không có kế hoạch (`not planned`).

## Câu hỏi chưa giải quyết
- #329: có cần thử lại thực tế với API key workspace trước khi đóng không?
- #58: giữ trong roadmap hay đóng ở trạng thái `not planned`?
- Ai có quyền TOSE để làm #357 và #213?
