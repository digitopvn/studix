# Dogfood: video giới thiệu Studix, A (skill ak-motion-video) và B (Studix MCP)

Ngày 2026-11-11. Video lưu ngoài repo tại `/Volumes/GOON/claude/studix/dogfood-videos/`.

## Video A (skill `ak-motion-video`, `--poor`)

- File: `video-a/renders/studix-intro.mp4` (bản social: `studix-intro-social.mp4`, 9,9 MB). Báo cáo chi tiết: `video-a/REPORT.md`.
- Style `cinematic-product-launch`: đen, trắng ngà, xanh dương; 9 cảnh; nhạc 100 BPM ghép theo bar.
- Thời gian khoảng 18 phút. Chi phí ước tính dưới 1–2 USD: 9 lần TTS Gemini, 5 SFX ElevenLabs, 2 bản nhạc ElevenLabs, 9 lần forced alignment.
- Kiểm tra: 1920×1080, 30 fps, 63,0 s (lố 3 s so với 60 s). −13,9 LUFS, true peak −1,0 dBTP. Blackdetect chỉ thấy fade-in 0,27 s. Lệch ghép nhạc 0 ms; nhạc thấp hơn voice 5,1 dB. `hyperframes lint` và `check` đều qua.
- Hình: ô nhập prompt có chữ được gõ dần, khung "film" có thanh tiến độ, code block `mcp.json` nối dây tới chip Claude/ChatGPT, thẻ đoàn làm phim, dãy 5 thẻ scene, checklist job→preview→duyệt, bộ đếm credit lăn số, nút CTA dạng viên thuốc.
- Điểm yếu tự nhận: khoảng 1,2 s đầu gần như đen; không có UI thật; nhạc không có drop rõ.

## Video B, vòng 0 (production trước các bản sửa)

- Gọi `studix_create_video` (`workflowTemplate: "motion-graphic"`, chỉ `prompt`, yêu cầu 60 s 16:9, `renderPreset: final`).
- Job `job_01m755njqg1sfav0s8be12e4f0`, project `prj_01m755njpz6yy4eaw07yn1et2f`.
- Thời gian: 3 phút (11:25:10 → 11:28:10 UTC). Chi phí: 31¢ (voice 7¢, nhạc 23¢, storyboard Pi DeepSeek V4.1 Flash ~0,8¢).
- File: `video-b-r0/b-r0.mp4`. ffprobe: **1080×1920, 15 s** (sai cả tỉ lệ và độ dài so với yêu cầu), 30 fps, AAC 48 kHz stereo, −14,5 LUFS.
- Hình: 6 thẻ chữ phẳng nền đen/cam xen kẽ, mỗi thẻ một dòng chữ, chỉ có enter/exit đơn giản. Không có sơ đồ, icon, lớp chiều sâu hay chuyển động camera. Caption chữ rất nhỏ, lặp lại gần nguyên văn câu trên màn hình.
- Âm thanh: voice ElevenLabs rõ, nhạc nền ở 0,18, một SFX duy nhất ở CTA; các lần cắt cảnh im lặng.
- Brand trong IR là câu hook ("Describe a video. Get a film.") thay vì "Studix".

## Vấn đề MCP tìm thấy và issue

| # | Vấn đề | Issue | Trạng thái |
|---|---|---|---|
| 1 | Độ dài/tỉ lệ ghi trong prompt bị bỏ qua (60 s 16:9 → 15 s 9:16) | [#368](https://github.com/digitopvn/studix/issues/368) | PR [#371](https://github.com/digitopvn/studix/pull/371) |
| 2 | Tối đa 6 beat bất kể độ dài; cắt cảnh không có âm | [#369](https://github.com/digitopvn/studix/issues/369) | PR #371 |
| 3 | Tên brand lấy từ câu hook | [#370](https://github.com/digitopvn/studix/issues/370) | PR #371 |
| — | Chất lượng hình tổng thể chỉ là thẻ chữ, `job.agent.runtime` báo `none` dù storyboard chạy Pi | đã có ở [#351](https://github.com/digitopvn/studix/issues/351) | không tạo trùng |

## Tiến độ theo vòng

- Vòng 0: B baseline như trên.
- Vòng 1: PR #371 merge lúc 11:37Z. Chạy lại cùng prompt (job `job_01m756qyq4c3bbvq907ybsjzas`): storyboard ra 12 beat cho 60 s đúng ý, nhưng stage voice fail vì IR giới hạn 16 track audio (hồi quy do chính #371), tốn 12¢. Lỗi trả về là dump zod thô với mã `INTERNAL`. Đã mở [#377](https://github.com/digitopvn/studix/issues/377), [#378](https://github.com/digitopvn/studix/issues/378) và PR [#380](https://github.com/digitopvn/studix/pull/380) (merge 11:50Z, deploy xong).
- Vòng 2 (sau #380): job `job_01m757f2h07yp04c418tez1yvn` fail hai lần. Lần 1: 429 vì 12 TTS song song ([#392](https://github.com/digitopvn/studix/issues/392), PR [#394](https://github.com/digitopvn/studix/pull/394)). Lần 2: một câu đọc 7,5 s trong card 6,6 s, job dừng hẳn, `retry` dùng lại take cũ nên vô ích ([#393](https://github.com/digitopvn/studix/issues/393), đang sửa bằng cách đo take rồi chia lại nhịp card).
- Vòng 2b: job mới `job_01m757v82xx3nj6n7bkga2zxb0` thành công trong 4 phút 38 giây, 100¢ (nhạc 90¢, voice 9¢, storyboard 0,65¢; accent và whoosh dùng lại nên 0¢). File `video-b-r2/b-r2.mp4`: **1920×1080, 60,0 s**, −14,4 LUFS, peak −1,5 dBFS, không frame đen; 12 card, CTA có chữ "Studix". Các sửa #368, #369, #370 đã có hiệu lực. Còn lại: vẫn chỉ là thẻ chữ đen/cam xen kẽ, một cue caption mồ côi "about." ([#397](https://github.com/digitopvn/studix/issues/397)).
- Vòng 3 (sau PR [#411](https://github.com/digitopvn/studix/pull/411): đo take rồi chia lại nhịp card, 3 TTS song song; đóng #392, #393): job `job_01m75c61hbbe3swdqpcb0htcmh` thành công **ngay lần đầu**, 6 phút 3 giây, 102¢ (nhạc 90¢, voice 10¢, storyboard 1¢). File `video-b-r3/b-r3.mp4`: 1920×1080, 60,0 s, −14,6 LUFS, peak −2,1 dBFS. Độ tin cậy đã ổn; hình vẫn là thẻ chữ một dòng. Mở [#412](https://github.com/digitopvn/studix/issues/412): cho storyboard chọn layout trực quan thật (prompt-box, code, chips, checklist, counter…), đang hiện thực.
- Vòng 4 (sau PR [#414](https://github.com/digitopvn/studix/pull/414): layout trực quan theo beat, đóng #412): job `job_01m75g8xsc387amyczwv78e9c3` thành công ngay lần đầu, 6 phút 44 giây, 102¢ (nhạc 90¢, voice 11¢, storyboard 0,7¢). File `video-b-r4/b-r4.mp4`: 1920×1080, 60,0 s, −14,6 LUFS. Storyboard dùng đủ layout: thẻ 01/02/03 "Logo misspelled", sơ đồ HTTPS /mcp nối Claude/ChatGPT/Any agent, ô prompt gõ dần, checklist Director/Producer/Frames, ô màu thương hiệu, code "scene 04 re-rendered", bộ đếm 5,000, chữ MIT, CTA nền cyan. Khoảng cách với A đã thu hẹp rõ. Còn lại: layout và tiêu đề quá nhỏ so với khung 16:9 (nhiều khoảng trống), caption ~14px, một cue caption lệch sang card kế tiếp. Đã mở [#420](https://github.com/digitopvn/studix/issues/420), đang sửa.

## Video A v2 (skill `ak-motion-video`, chế độ mặc định, director/reviewer fable, operator Opus 5.5)

- File: `video-a-v2/renders/studix-intro-v2.mp4` (bản social 22 MB). Báo cáo: `video-a-v2/REPORT.md`.
- Thời gian khoảng 3 giờ 04 phút. Chi phí audio khoảng 1,5–3 USD, cộng phần token của nhiều subagent (đáng kể, không đo chính xác).
- Kiểm tra: 1920×1080, 30 fps, 60,000 s, −14,0 LUFS, −1,2 dBTP, không frame đen, lệch ghép nhạc ±0,4 ms, nhạc dưới voice 4,6 dB, lint/check 0 lỗi, hai vòng review thẩm mỹ.
- Hình: UI sản phẩm thật (ô chat gõ brief, lệnh `studix_create_video` chạy, pipeline job, sơ đồ crew, player preview có nút Approve, đồng hồ credit có budget cap, logo Studix), một khối bo tròn xuyên suốt các cảnh, hai drop nhạc cắt đúng beat.
- Tự nhận còn yếu: drop 1 hơi tối, ba chỗ chuyển cảnh trống 0,15–0,3 s, 23 nhãn UI 16–19 px (dưới ngưỡng 20 px).

## So sánh A v2 và B vòng 4

| Tiêu chí | A v2 (skill) | B vòng 4 (Studix MCP) |
|---|---|---|
| Kịch bản | Đủ ý, câu chữ sắc, có logo và tên thương hiệu | Đủ ý theo prompt, câu gọn; một câu voice ghép hai ý trên thẻ MIT |
| Hình và chuyển động | UI sản phẩm thật, chiều sâu, camera, khối xuyên cảnh | Layout trực quan đúng ý từng beat, nhưng phẳng, nhỏ trong khung, không camera |
| Typography | Tinh, nhiều cấp | Sạch nhưng nhỏ so với khung 16:9 (đang sửa ở #422) |
| Nhạc, SFX, voice | Nhạc ghép theo bar, hai drop thiết kế | Nhạc nền, whoosh ở mỗi lần cắt, voice ElevenLabs rõ |
| Khớp beat | Cắt và reveal theo beat và theo từ | Cắt theo nhịp voice; không bám beat nhạc |
| Lỗi kỹ thuật | Không | Không (chạy một lần là xong) |
| Thời gian | ~3 giờ | 6 phút 44 giây |
| Chi phí | ~1,5–3 USD audio + token nhiều agent | 1,02 USD tổng cộng |

Kết luận: A vẫn hơn rõ về độ "film" (UI thật, chiều sâu, khớp beat). B nhanh hơn khoảng 27 lần và rẻ hơn nhiều, chạy ổn định một phát ăn ngay, và sau #414 đã chuyển từ thẻ chữ sang hình minh họa có nghĩa. Khoảng cách còn lại chủ yếu ở: kích thước và chiều sâu bố cục (#420/#422), cắt theo beat nhạc, và chưa có UI/logo thật của thương hiệu.

## Vòng 5 (sau PR [#422](https://github.com/digitopvn/studix/pull/422): phóng to layout 16:9, caption 40 px)

- Job `job_01m75jrga6d5gfpwb551xyckcq`. Lần 1 fail ở storyboard: model trả JSON hỏng, bị đánh dấu không retry được, job dừng ngay ([#431](https://github.com/digitopvn/studix/issues/431), PR [#432](https://github.com/digitopvn/studix/pull/432): sửa JSON rồi hỏi lại model tối đa 2 lần). Sau `studix_retry_job` thì thành công. Tổng 104¢, khoảng 7 phút cho lần chạy thành công.
- File `video-b-r5/b-r5.mp4`: 1920×1080, 60,0 s, −14,3 LUFS. Layout to hơn rõ (code block, sơ đồ agent, checklist crew, ô màu, dãy thẻ scene có thẻ được chọn nhấc lên, counter lăn số, MIT, CTA nền cam). Caption khớp đúng card. Cue lệch ở vòng 4 là do câu voice của storyboard gộp hai ý, không phải lỗi timing.
- Còn lại so với A: chưa có UI sản phẩm thật hay logo, không có camera hay chiều sâu, không cắt theo beat nhạc, một vài card vẫn chỉ có tiêu đề ("Pixels and hope.", "A launch needs spelling."). CI: job QA speech hỏng vì apt mirror ([#426](https://github.com/digitopvn/studix/issues/426)).

## Issue và PR trong vòng dogfood

| Issue | PR | Trạng thái |
|---|---|---|
| #368, #369, #370 | #371 | merged, deploy |
| #377, #378 | #380 | merged, deploy |
| #392, #393 | #411 | merged, deploy |
| #412 | #414 | merged, deploy |
| #420 | #422 | merged, deploy |
| #431 | #432 | merged, deploy |
| #397 (cue mồ côi), #426 (CI apt), #351 (agent.runtime "none") | — | còn mở |

## Vòng 6 (sau release [#467](https://github.com/digitopvn/studix/pull/467): beat sync, camera và chiều sâu, QA hình ảnh, UI kit, brand kit, style preset)

- Job `job_01m773xng2jpdttp2vgep82fs8`: thành công ngay lần đầu, 11 phút 27 giây, 105¢. File `video-b-r6/b-r6.mp4`: 1920×1080, 60,0 s, −14,6 LUFS.
- Tiến bộ: màu thương hiệu lấy từ site (tím), nền có glow và chiều sâu, nhiều device UI mới (prompt box có nút Send, pipeline Script→Publish, preview player có Approve, code `edit_scene`, sơ đồ /mcp). Nhạc chia section và cắt theo beat.
- Hồi quy hoặc lỗi mới:
  - device xuất hiện quá muộn, nửa thời gian card chỉ có tiêu đề ([#468](https://github.com/digitopvn/studix/issues/468));
  - chấm motif trôi ngẫu nhiên, đè chữ ([#469](https://github.com/digitopvn/studix/issues/469));
  - bộ đếm lăn hiện số lỗi "4,0'5" ([#470](https://github.com/digitopvn/studix/issues/470));
  - QA hình ảnh chấm điểm nhưng không kịp sửa và có thể không nhìn thấy ảnh ([#471](https://github.com/digitopvn/studix/issues/471)).
- So với A v2: vẫn kém, chủ yếu vì các card trống quá lâu và motif lộn xộn. Khi sửa xong #468 và #469, khoảng cách sẽ hẹp đáng kể.

## Vòng 7 (director tier lần đầu, [#476](https://github.com/digitopvn/studix/pull/476), [#481](https://github.com/digitopvn/studix/pull/481))

- Job `job_01m77bv0e2rbwk9x9815sxdek6`: 60 s, 124¢, 16,5 phút. Hook rơi về card vì director vượt schema (`rhythm` dài 304 ký tự).
- Lỗi khác: device xuất hiện muộn, motif đè chữ, bộ đếm hỏng chữ số, một frame trống ở khoảng 37 s, elip CTA cắt chữ, palette chỉ có một màu xanh.
- Đã sửa: [#477](https://github.com/digitopvn/studix/pull/477) (schema lỏng hơn, có lượt repair), [#478](https://github.com/digitopvn/studix/pull/478) (visual QA dùng ảnh tĩnh), [#479](https://github.com/digitopvn/studix/pull/479), [#480](https://github.com/digitopvn/studix/pull/480), [#482](https://github.com/digitopvn/studix/pull/482) (lỗi hình). Release [#483](https://github.com/digitopvn/studix/pull/483).

## Thử hook 15 s (director và builder chạy kimi-k3.1-pro)

| Lần | Job | Kết quả | Nguyên nhân, cách sửa |
| --- | --- | --- | --- |
| a | `job_01m77f5jq7s6h5w4b0nag82x5g` | fail ở visual-qa | match-cut cần motif, nhưng scene authored không có motif. Sửa ở [#484](https://github.com/digitopvn/studix/pull/484) (đổi thành `cut`) |
| b | `job_01m77h5wcrj9qvzpxypxe4d72s` | hook rơi về card | builder khai báo lại `const sid`, sau bundle thành `sid2` và gây lỗi TDZ. Sửa ở [#485](https://github.com/digitopvn/studix/pull/485) (static check, bọc js trong khối riêng) |
| c | `job_01m77jsezqzf1p7737wbb27mxw` | hook vào phim nhưng mất khung chính; dựng scene mất 16 phút | class `sweep` của shell làm container của builder có opacity 0; `filter: blur(80px)` treo render đến khi bị kill ở 600 s. Sửa ở [#487](https://github.com/digitopvn/studix/pull/487) |
| d | `job_01m77ndxk40a5m0y8qdfa7bepb` | thành công: 11 phút, 61¢, dựng scene 4 phút | hook do director dựng có khung kính và từ khoá sáng theo giọng đọc |

## Vòng 8 (sau release [#486](https://github.com/digitopvn/studix/pull/486) và #487, builder chạy kimi-k3.1-pro)

- Job `job_01m77p919k4fpaxhkpsvh3w848`: thành công ngay lần đầu, 60,0 s, 165¢, khoảng 25 phút. File `video-b-r8/b-r8.mp4`.
- Tiến bộ so với vòng 7: không còn frame trống; palette có xanh và vàng; mỗi beat có một device rõ ràng (so sánh paint vs spell, sơ đồ /mcp, `edit_scene`, timeline async, preview có Approve, bộ đếm 5,000, thanh ngân sách, MIT); hook do director dựng đã vào phim.
- Còn yếu:
  - hook nhỏ: khung nằm ở một phần ba trên, chữ khoảng 20 px;
  - thẻ đoàn làm phim (director, producer, frame check) quá nhỏ, visual QA chấm 6/10;
  - visual QA không chấm scene authored.
- Đang làm: visual QA chấm cả scene authored và có một lượt repair builder; prompt builder có ngưỡng tỉ lệ khung hình.
- So với A v2: B đã gần về cấu trúc và độ rõ thông tin. A vẫn hơn ở hook điện ảnh và chuyển động của hero. Chưa đạt mức ngang A.

## Vòng 9–13 (12/11/2026): chấm mù B với A v2

Cùng prompt và role (director, builder: kimi-k3.1-pro, high). Judge chỉ xem 9 frame ở các giây cố định, nhãn ngẫu nhiên. Cùng một file A, điểm của A dao động khoảng ±0,3 giữa các lần chấm.

| Vòng | Job | Chi phí | Thời gian | B | A v2 | Thay đổi trước vòng |
|---|---|---|---|---|---|---|
| 9 | job_01m77sg2ps8jv0f6jt282napyj | 155¢ | 23 phút | 5,0 | 7,5 | #489: visual QA chấm và sửa scene authored |
| 10 | job_01m77xa9ywq5h7fz109sycyay6 | 144¢ | 28,5 phút | 5,5 | 7,0 | #491 caption theo cụm, URL dạng viết, safe area; #492 card lấp khung, chip đạt AA, CTA lockup |
| 11 | job_01m7812qg180gewyfjnva6j5f8 | 156¢ | 25 phút | 6,0 | 7,3 | #494 CTA chỉ có URL, cấm headline mờ, deadline cho redesign QA, màu accent |
| 12 | job_01m783rwgga2k8r9sqsnrbanxy | 163¢ | 30 phút | 5,6 | 7,3 | #496 cổng check chỉ chặn lỗi lint/runtime, caption không lặp headline, bokeh inset |
| 13 | job_01m786yk44fa5scc864b5mprzq | 156¢ | 27 phút | 5,6 | 7,4 | #498 kẹp camera của shell, repair layout không bị chặn, card không chỉ có headline |

Lỗi gốc tìm được:
- Vòng 11: `hyperframes check` 0.8.77 trả exit 1 khi có bất kỳ finding mức error nào, nên hook authored rơi về card. Cổng này có từ trước #491, và log cắt đuôi che mất lỗi.
- Vòng 12: builder gọi `settleCam(.cam, t0, t1, 4)` nên camera zoom 1→5x và cắt cả hai mép. Lượt repair cắt mép bị bỏ qua vì `lastRuns === 2`, và mọi lời khuyên repair đều nhắm vào cỡ chữ.
- Vòng 13: hook không còn bị cắt (visual QA 9/10).

Kết luận: điểm B đi ngang quanh 5,5–6. Judge nhất quán nói A là product film (UI sản phẩm liền mạch, một tông màu, CTA có logo khép vòng với hook), còn B là slide deck có bokeh. Contact sheet 1 fps của vòng 13 cho thấy:
- mỗi card mở đầu khoảng 1 giây gần trống trước khi device hiện;
- có frame trống ở các điểm cắt (0:04, 0:14, 0:24);
- headline nhỏ ở trên, device nhỏ ở giữa;
- có chấm vàng sắc nét ở mép;
- CTA không có logo, vì brand kit không có logo: đây là thiếu đầu vào, không phải lỗi renderer.

Sửa từng điểm judge chê không còn kéo điểm lên. Bước tiếp theo là đổi hướng thiết kế (tham vấn kongming), cùng sửa cách đo: lấy mẫu ở giữa mỗi scene và dùng 2–3 judge.

## Vòng 14–16 (13/11/2026): film mode

Film mode (#500): director viết `system` (một bề mặt UI sản phẩm), 5 builder chạy song song, cả phim check và render một lần trong sandbox, rồi cắt thành từng clip theo scene.

Từ vòng này đổi cách đo: lấy 15 frame mỗi video (cứ 4 giây một frame), chấm bằng 3 judge độc lập và lấy trung vị.

| Vòng | Job | Scene authored | Chi phí | Thời gian | B | A v2 | Ghi chú |
|---|---|---|---|---|---|---|---|
| 14 | job_01m78f3w3swb4g6yh8vm7568yj | 6/12 | – | – | – | – | Không chấm. Một builder chạm cap làm cả job phải chờ duyệt (sửa ở #502); lint `gsap_non_transform_motion` loại 6 scene (#504) |
| 15 | job_01m78hcqwyek2rmfrkpdbatce8 | 7/12 | 248¢ | 53 phút | – | – | Không chấm. 5 builder hết giờ với timeout 5 phút; nâng lên 10 phút ở #506 |
| 16 | job_01m78n3s76vz1mphgss526xkmw | 12/12 | 314¢ | 52 phút | 5,2 (4,4 / 5,2 / 5,3) | 7,3 (7,1 / 7,6 / 7,3) | Lần đầu cả 12 scene đều authored |

Cả 3 judge chê vòng 16 giống nhau:
- Phim đọc như một tour dashboard: scene nào cũng là cùng một panel trong khung viền vàng, camera gần như đứng yên.
- Nhãn mono rất nhỏ ("TRACKING +080", mã hex), không có chênh lệch cỡ chữ. Thông điệp chỉ đến được nhờ caption.
- Chữ và thanh đè lên nhau ở 0:01, 0:37, 0:49 và 0:53.
- Hook mở bằng ô prompt trống. CTA chỉ có URL trên một hộp xám, không có logo.

Phía A cũng có lỗi: frame chết ở 0:13, và vài caption mờ.

Kết luận: film mode đã gỡ được bài toán "slide deck có bokeh", nhưng chuyển sang "dashboard nhỏ chữ". Điểm chưa tăng (5,6 → 5,2). Builder v7 (#508) sửa theo đúng các nhận xét trên:
- mỗi scene có một con số hoặc chữ hero cỡ headline;
- tối đa 6 nhãn, bỏ chữ spec trang trí;
- đổi khung hình giữa các scene;
- cấm chữ và thanh đè nhau;
- hook mở khi sản phẩm đã chạy;
- CTA kết bằng lockup có logo.
