# HyperFrames upstream review: 0.8.78 → 0.8.223

Ngày: 2026-10-31. Phạm vi: đọc và khuyến nghị, không đổi code. Studix đọc trên `origin/dev`.

## Kết luận

**Nâng cả ba package `@hyperframes/core`, `@hyperframes/lint` và `@hyperframes/producer` lên `0.8.223`, pin exact. Kèm theo đó có vài thay đổi nhỏ ở code và test.**

- API mà adapter gọi không có breaking change. `createRenderJob`, `executeRenderJob`, `RenderCancelledError`, các field của `RenderConfigInput` mà Studix truyền, các field của `RenderJob` mà Studix đọc (`progress`, `currentStage`, `failedStage`, `error`, `status`, `warnings`) và `lintProject` đều giữ nguyên chữ ký. Những gì mới đều là thêm vào.
- Upstream có 145 release trong khoảng 0.8.78 → 0.8.223, kéo dài từ 2026-09-26 đến 2026-10-31. Trong đó có nhiều fix chạm trực tiếp vào thứ Studix vừa merge (video shot ở #42) và thứ sắp làm (9:16 ở 1080x1920, GSAP, render dài trong pod). Đáng kể nhất là bản fix màn hình bị **đen 8 cột pixel bên phải ở chiều rộng 1080** khi chạy FFmpeg 7.1/8.0.
- "Code changes" ở đây chỉ gồm việc truyền `maxRenderMs` từ timeout của job (tùy chọn), chạy lại integration và golden test, và cập nhật `docs/RENDERER.md`. Không cần sửa adapter.
- Thời điểm: nên đưa bản nâng cấp vào `dev` thành một PR nhỏ **trước khi** merge #45 và #47. Nếu không kịp thì làm ngay sau khi một trong hai merge. PR này chỉ chạm `packages/renderers/package.json` và `pnpm-lock.yaml` nên khả năng va chạm thấp, nhưng lockfile thì xung đột với mọi PR có đổi dependency.
- **Issue #5 vẫn chưa giải được ở 0.8.223.** Engine vẫn chưa cho tắt `handleSIGTERM`. Chi tiết ở mục 4.
- Licence: vẫn là Apache-2.0 và file `LICENSE` không đổi byte nào. Riêng `package.json` của 0.8.223 không còn field `license`; đây chỉ là metadata.
- Security: repo không có GitHub Security Advisory nào được công bố. Trong changelog có một fix chống SSRF cho downloader của engine và một bản nâng esbuild vì advisory; cả hai đều **không ảnh hưởng** Studix (mục 3).

## 1. Phía Studix (đã kiểm chứng trên `origin/dev`)

| Bề mặt | Studix dùng gì |
| --- | --- |
| `packages/renderers/package.json` | `@hyperframes/core`, `lint`, `producer` đều `0.8.78`, kèm `gsap 3.14.2` |
| `packages/renderers/src/hyperframes/producer-render.ts` | `createRenderJob({fps, quality, format:"mp4", entryFile, strictness:"best-effort", hdrMode:"force-sdr", crf, logger, workers?})`, `executeRenderJob(job, dir, out, onProgress, signal)`, `RenderCancelledError`, `job.{progress,currentStage,failedStage,error,status,warnings}` |
| `packages/renderers/test/compile-composition.test.ts` | `lintProject` từ `@hyperframes/lint` |
| `hyperframes-support.ts` | Không import HyperFrames. Danh sách mime nằm trong `compile-composition.ts` |
| `render-toolchain.ts` | Tìm browser qua `HYPERFRAMES_BROWSER_PATH` / `PRODUCER_HEADLESS_SHELL_PATH` và cache `~/.cache/{hyperframes,puppeteer}` |
| `Dockerfile` (worker) | `node:22-bookworm-slim`, FFmpeg 5.1 của Debian, `chrome-headless-shell@stable` **không pin** (đo được 156.0.8078.80); arm64 dùng Chromium của Debian; đặt **cả hai** biến browser trỏ cùng một path |
| CI `.github/workflows/ci.yml` | `ubuntu-latest` với FFmpeg qua apt (6.1, đây là suy luận), `chrome-headless-shell@stable` không pin |
| `docs/RENDERER.md` | Ghi đã kiểm chứng trên FFmpeg 8.0 (máy dev) và 5.1 (worker); WebGL qua SwiftShader |

Âm thanh do FFmpeg của Studix mix (`ffmpeg/audio-mix.ts`); trong composition, video luôn bị muted. Asset được `copyFile` vào thư mục project nên engine không phải tải URL nào.

## 2. Thay đổi upstream liên quan

Cột "Kiểm chứng" có hai giá trị. **V** nghĩa là đã đọc release note, PR hoặc mã `dist` trên npm. **Đoán** nghĩa là tác động lên Studix được suy ra nhưng chưa render thử.

### 2.1 Video shot và encode (#42 đã merge, #45 sắp làm)

| Bản | Thay đổi | Tác động lên Studix | File Studix | Kiểm chứng |
| --- | --- | --- | --- | --- |
| 0.8.155 | [#5559](https://github.com/heygen-com/hyperframes/pull/5559) Giữ 8 cột pixel bên phải của MP4 SDR ở chiều rộng như 1080 (FFmpeg 7.1 và 8.0 tô đen 8 cột cuối khi width = 16k+8) | **Cao.** 1080 = 16·67+8. Mọi render 1080x1920 (9:16 cho `marketing-video`) hoặc 1080x1080 trên máy dev chạy FFmpeg 8.0 bị viền đen 8 px. Master được stream-copy nên lỗi đi thẳng vào file giao. Worker (5.1) và CI (6.1) không bị | `producer-render.ts` (không sửa), test golden | V (PR), tác động: Đoán (chưa tái hiện) |
| 0.8.156 | [#5572](https://github.com/heygen-com/hyperframes/pull/5572) Lấy mẫu video VFR theo timestamp để video không bị đứng hình trên FFmpeg 8 | Trung bình. Màn hình quay hoặc video điện thoại (VFR) trong video shot bị đứng khung trên máy FFmpeg 8 | `compile-composition.ts` (không sửa) | V |
| 0.8.80 / 0.8.82 | [#4565](https://github.com/heygen-com/hyperframes/pull/4565), [#4596](https://github.com/heygen-com/hyperframes/pull/4596) Video được vẽ đúng các frame nó hiển thị, và render khớp frame với preview | Trung bình. Độ chính xác của `data-start` / `data-media-start` (`trimStartMs`) | `scene-composition.ts`, `shot-markup.ts` | V |
| 0.8.205–0.8.222 | [#6424](https://github.com/heygen-com/hyperframes/pull/6424) video bị giữ quá cuối media vẫn theo animation; [#6664](https://github.com/heygen-com/hyperframes/pull/6664) MP4/WebM bắt đầu muộn render đủ frame; [#6759](https://github.com/heygen-com/hyperframes/pull/6759) clip bắt đầu giữa hai frame hiện đúng frame | Trung bình. Video shot đặt giữa scene là trường hợp thường gặp | như trên | V |
| 0.8.173 | [#5849](https://github.com/heygen-com/hyperframes/pull/5849) Clip 29.97 fps xuất mượt ở 30 fps | Trung bình. Footage điện thoại cho ads | — | V |
| 0.8.150 | [#5494](https://github.com/heygen-com/hyperframes/pull/5494) Giới hạn tài nguyên giữ lại khi inject frame video (trước đây RAM tăng theo từng frame) | Trung bình. Render dài có video trong pod giới hạn 4 GB | — | V; chú ý: `injectVideoFramesBatch` đổi ngữ nghĩa URL, nhưng Studix không gọi API engine |
| 0.8.189 / 0.8.191 | [#6127](https://github.com/heygen-com/hyperframes/pull/6127) Số thread x264/x265 như nhau trên mọi kích cỡ host; chỉ h264 được giữ byte-identical giữa các host ([#6167](https://github.com/heygen-com/hyperframes/pull/6167)) | Tốt cho tính tái lập giữa máy dev, CI và worker | test golden | V |
| 0.8.207 | [#6444](https://github.com/heygen-com/hyperframes/pull/6444) Đặt keyframe interval và trần bitrate (option mới `keyframeIntervalSeconds`, `maxBitrate`, `bufferSize`) | Output thay đổi byte. Có thể dùng `maxBitrate` cho bản phone, nhưng Studix đã tự encode bản phone hai pass | `producer-render.ts` (tùy chọn) | V (d.ts) |
| 0.8.216 | [#6640](https://github.com/heygen-com/hyperframes/pull/6640) `quality: "high"` encode với x264 preset `fast` | Render `final` nhanh hơn, kích thước và chất lượng có thể khác một chút | — | V; chất lượng: Đoán |
| 0.8.206 | [#6455](https://github.com/heygen-com/hyperframes/pull/6455) HEIC → JPEG lúc compile | Studix chưa chấp nhận HEIC (`hyperframesSupport` báo lỗi). Có thể mở rộng sau | `compile-composition.ts`, `hyperframes-support.ts` | V |

### 2.2 Độ bền khi render trong pod (worker, #5)

| Bản | Thay đổi | Tác động | File Studix | Kiểm chứng |
| --- | --- | --- | --- | --- |
| 0.8.87 | [#4694](https://github.com/heygen-com/hyperframes/pull/4694) Render bị ngắt không để lại frame đã capture | Giảm rác đĩa khi drain hoặc cancel | — | V |
| 0.8.145 / 0.8.147 | [#5375](https://github.com/heygen-com/hyperframes/pull/5375) Export dài nhiều clip không còn đứng ở 90%; [#5450](https://github.com/heygen-com/hyperframes/pull/5450) khi stall thì báo bước Chrome bị treo | Lỗi dễ chẩn đoán hơn trong `StudixError.details.stage` | `producer-render.ts` | V |
| 0.8.204 | [#6413](https://github.com/heygen-com/hyperframes/pull/6413) Capture ngừng tiến thì fail trong vài phút | Job không giữ lease vô hạn | — | V |
| ≤0.8.223 (không có trong changelog) | `RenderConfig.maxRenderMs` (ETA guard theo wall time; có trong d.ts 0.8.223, không có ở 0.8.78) | Có thể truyền từ timeout của job để producer tự dừng sớm | `producer-render.ts` | V (d.ts) |
| 0.8.216 | [#6641](https://github.com/heygen-com/hyperframes/pull/6641) Số worker tính theo heap đo được và **CPU quota của container** | Worker trên TOSE/k8s không còn tính theo số core của node. Phù hợp với số đo WebGL ở `RENDERER.md` | — | V (PR); tác động: Đoán |
| 0.8.216 | [#6701](https://github.com/heygen-com/hyperframes/pull/6701) BeginFrame không vẽ được frame đầu sau 20 s thì chuyển sang screenshot; [#6490](https://github.com/heygen-com/hyperframes/pull/6490) capture BeginFrame bị stall thì chạy tiếp từ frame chưa ghi | Ít fail hơn trên SwiftShader | — | V |
| 0.8.183 | [#5987](https://github.com/heygen-com/hyperframes/pull/5987) Khi đặt cả hai biến browser thì dùng browser CLI đã chọn; Chrome hệ thống trên Linux không đi đường BeginFrame | Dockerfile đặt cả hai biến; nhánh arm64 dùng Chromium của Debian. Hành vi giờ được định nghĩa rõ | `Dockerfile`, `render-toolchain.ts` | V |
| 0.8.208 | [#6547](https://github.com/heygen-com/hyperframes/pull/6547) Chrome shell bỏ qua SIGTERM không làm treo CLI lúc launch | Fix này thuộc CLI và **không giải #5** | — | V |

### 2.3 GSAP, font, captions (`motion-graphic`, #45)

| Bản | Thay đổi | Tác động | Kiểm chứng |
| --- | --- | --- | --- |
| 0.8.113–0.8.151 | [#4911](https://github.com/heygen-com/hyperframes/pull/4911) `gsap.set` vẽ đúng frame; [#4942](https://github.com/heygen-com/hyperframes/pull/4942) seek vào điểm bắt đầu tween hiện đúng tween; [#4948](https://github.com/heygen-com/hyperframes/pull/4948) lệnh GSAP thêm sau lần seek đầu chỉ chạy một lần; [#5503](https://github.com/heygen-com/hyperframes/pull/5503) animation tại lần seek đầu hiện đúng thời điểm | Cao cho motion graphic: các lỗi lệch frame ở đầu và cuối tween | V |
| 0.8.201 | [#6354](https://github.com/heygen-com/hyperframes/pull/6354) Root không có `data-duration` vẫn hiển thị sau khi timeline GSAP kết thúc | Trung bình | V |
| 0.8.122 | [#4980](https://github.com/heygen-com/hyperframes/pull/4980) Script của composition chỉ chạy sau khi web font sẵn sàng, nên render lặp lại được | Cao cho captions Be Vietnam Pro đo layout bằng JS | V |
| 0.8.205 / 0.8.213 | [#6395](https://github.com/heygen-com/hyperframes/pull/6395) khử trùng lặp font-face; [#6665](https://github.com/heygen-com/hyperframes/pull/6665) bundler thấy font trong stylesheet được link | Liên quan `bundled-fonts.ts` | V; tác động: Đoán |
| 0.8.209 | [#6543](https://github.com/heygen-com/hyperframes/pull/6543) Text do script tách thành từng chữ chỉ hiện một lần | Liên quan karaoke và caption theo chữ | V |
| 0.8.112 | [#3797](https://github.com/heygen-com/hyperframes/pull/3797) Lint báo CSS transition không an toàn khi seek; cùng nhiều rule caption/font mới | `compile-composition.test.ts` có thể nhận finding mới. Cần chạy lại test | V (rule); kết quả test: Đoán |
| 0.8.165 | [#5690](https://github.com/heygen-com/hyperframes/pull/5690) Dòng caption hiện lại sau khi playhead nhảy lùi | Đây là caption component của HF; Studix tự vẽ caption nên có lẽ không ảnh hưởng | Đoán |

### 2.4 WebGL (film-engine, #47)

| Hạng mục | Kết quả | Kiểm chứng |
| --- | --- | --- |
| Software GL | Cả 0.8.78 lẫn 0.8.223 đều tự thêm `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` khi chọn chế độ `software` (`engine/dist/services/browserManager.js`). 0.8.223 thêm `--use-vulkan=swiftshader` cho WebGPU chạy bằng phần mềm | V (dist) |
| Workaround SwiftShader compositor (HF#3049) | Đã có từ 0.8.78 | V |
| [#3782](https://github.com/heygen-com/hyperframes/pull/3782) | Ghim capture surface ở 1 device pixel trên mỗi CSS pixel | V |
| [#6343](https://github.com/heygen-com/hyperframes/pull/6343), [#5735](https://github.com/heygen-com/hyperframes/pull/5735) | Kiểm tra WebGPU device trước khi capture; sub-composition WebGPU chạy như root | V, chưa cần cho #47 |
| Multiplane, camera rig, captions cho anime | **Upstream không có tính năng mới nào cho việc này.** Film-engine vẫn phải tự viết bằng WebGL/three trong composition | V (không tìm thấy trong 1303 mục changelog) |
| [#6821](https://github.com/heygen-com/hyperframes/pull/6821) "Capture retries without WebGL under software GL" | Chỉ nằm trong `packages/cli/src/capture`, tức lệnh capture website, không phải producer. Không ảnh hưởng | V (file list) |

### 2.5 Âm thanh

Studix không để HyperFrames mix âm thanh nên các fix sau **không ảnh hưởng** đường render: [#5563](https://github.com/heygen-com/hyperframes/pull/5563), [#6120](https://github.com/heygen-com/hyperframes/pull/6120), [#5956](https://github.com/heygen-com/hyperframes/pull/5956), [#6089](https://github.com/heygen-com/hyperframes/pull/6089), [#5420](https://github.com/heygen-com/hyperframes/pull/5420) (`data-fx-chain` ở root giờ xử lý toàn bộ mix; Studix không đặt attribute này), [#5652](https://github.com/heygen-com/hyperframes/pull/5652). Hai thứ có thể tham khảo cho `marketing-video`: lệnh `hyperframes audio` đo onset, peak, pause và loudness ([#5602](https://github.com/heygen-com/hyperframes/pull/5602)), và bộ nhận diện giọng theo pitch ([#6653](https://github.com/heygen-com/hyperframes/pull/6653)). Cả hai chỉ có trong CLI và không cần cho việc nâng cấp.

## 3. Security

| Mục | Đánh giá |
| --- | --- |
| GitHub Security Advisories của `heygen-com/hyperframes` | Không có advisory nào được công bố (`gh api .../security-advisories` trả về rỗng). V |
| [#6571](https://github.com/heygen-com/hyperframes/pull/6571) (0.8.216) Downloader của engine từ chối host resolve ra địa chỉ private (SSRF qua DNS) | Studix copy asset vào thư mục project và không đưa URL vào composition, nên vừa không hưởng lợi vừa không bị chặn. Nếu sau này đưa URL MinIO nội bộ vào `src` thì **sẽ bị từ chối** (`http_rejected`). V (PR), tác động: Đoán |
| [#6297](https://github.com/heygen-com/hyperframes/pull/6297) Từ chối `previewUrl` private hoặc không phải HTTPS | Chỉ áp dụng cho render server; Studix không dùng. V |
| [#6277](https://github.com/heygen-com/hyperframes/pull/6277) Nâng esbuild vì advisory | Thuộc toolchain build của upstream. V |
| [#6440](https://github.com/heygen-com/hyperframes/pull/6440) Docker của upstream dùng Node 22.23.4 vì CVE-2026-111497 (Brotli) | Không thuộc package npm, nhưng **worker của Studix dùng `node:22-bookworm-slim` không pin patch**. Nên kiểm tra phiên bản Node khi build image. Đoán |
| [#5398](https://github.com/heygen-com/hyperframes/pull/5398) Producer chỉ ship code của chính nó, không kèm source map | Tarball nhỏ hơn. V |

## 4. Issue #5 (`handleSIGTERM`)

Đã kiểm chứng trong `@hyperframes/engine@0.8.223/dist/services/browserManager.js`:

```js
let hostHandlesSigint = false;
export function setHostHandlesSigint(owned) { hostHandlesSigint = owned; }
export const ownedLaunchOptions = () => ({ handleSIGINT: !hostHandlesSigint, pipe: true });
```

- Mọi lần launch (render, GPU probe, HDR capture) đều trải `ownedLaunchOptions()`. Engine không truyền `handleSIGTERM` nên Puppeteer 25.11 giữ mặc định `true`.
- Upstream chỉ thêm đường cho host tự lo **SIGINT** (`setHostHandlesSigint`, export từ `@hyperframes/engine`). SIGTERM thì chưa có. Producer không có option tương ứng, và `RenderConfigInput` cũng không có chỗ nào nhận launch options.
- [#4910](https://github.com/heygen-com/hyperframes/pull/4910) (merge 2026-10-03) tắt signal handler của Puppeteer, nhưng chỉ cho 6 chỗ launch trong **CLI** (`launchManagedBrowser`), không áp dụng cho engine và producer.
- Kết luận: **#5 vẫn bị chặn ở upstream.** Có một tin tốt: điểm cần vá giờ chỉ còn một dòng, và đã có tiền lệ API. Đề xuất gửi upstream: thêm `setHostHandlesSigterm(owned)` theo đúng mẫu của SIGINT, hoặc tổng quát thành `setHostHandlesSignals({ sigint, sigterm, sighup })`. Trong lúc chờ, có thể dùng `pnpm patch @hyperframes/engine@0.8.223` để thêm `handleSIGTERM: !hostHandlesSigterm`. Patch phải làm lại mỗi lần bump. Việc chọn giữa hai cách này thuộc chủ repo (xem comment trên #5).

## 5. Việc nên làm

1. **Nâng `@hyperframes/*` lên 0.8.223**: [digitopvn/studix#90](https://github.com/digitopvn/studix/issues/90), có nhãn `ai-handle`. Cụ thể: pin exact cả ba package; `@hyperframes/engine` sẽ được kéo theo qua producer. Chạy `compile-composition.test.ts`, `hyperframes-renderer.integration.test.ts` và `video-audio-golden.integration.test.ts` trên worker image và trên một máy có FFmpeg 8 với IR 1080x1920. Tùy chọn: truyền `maxRenderMs`. Cập nhật `docs/RENDERER.md` (phiên bản, ghi chú FFmpeg 8 và 1080). Tác động: `packages/renderers/package.json`, `pnpm-lock.yaml`, có thể `producer-render.ts` và `docs/RENDERER.md`.
2. **Pin `chrome-headless-shell` trong Dockerfile và CI**: [digitopvn/studix#91](https://github.com/digitopvn/studix/issues/91), có nhãn `ai-handle`. Engine 0.8.223 quản lý Chrome ở `152.0.7977.30` (`chromeHostCeiling.js`, `CHROME_VERSION`), trong khi Studix cài `@stable` (đang là 156) ở cả worker lẫn CI. Kết quả là pixel, số đo WebGL và golden có thể đổi mà không ai thay code. Nên pin một bản cụ thể, lý tưởng là trùng bản upstream test, và ghi bản đó vào `RENDERER.md`. Tác động: `Dockerfile`, `.github/workflows/ci.yml`, `docs/RENDERER.md`.
3. **#5**: đã cập nhật bằng chứng bằng một comment trên chính issue, không mở issue mới: [comment](https://github.com/digitopvn/studix/issues/5#issuecomment-6540978533).

## Quyết định đã chốt (2026-10-31)

Chủ repo giao cho agent tự quyết. Các quyết định đã ghi lên issue:

- **#5: vá bằng `pnpm patch` ngay trong PR của #90, đồng thời đề xuất `setHostHandlesSigterm` lên upstream.** Bản vá chỉ một dòng và gắn với đúng version, nên lần bump sau mà dòng đó đổi thì `pnpm install` sẽ báo lỗi. Chờ upstream thì không có mốc thời gian. [Comment](https://github.com/digitopvn/studix/issues/5#issuecomment-6541889222).
- **#90: merge trước #45 và #47.** PR có truyền `maxRenderMs` và gộp patch của #5. [Comment](https://github.com/digitopvn/studix/issues/90#issuecomment-6541889489).
- **#91: pin `156.0.8078.80`.** Đây là bản đã dùng để đo bảng WebGL trong `RENDERER.md`. Chrome for Testing có `chrome-headless-shell` 156 cho cả `linux64` và `linux-arm64`, còn 152 thiếu `linux-arm64`, nên nhánh arm64 cũng pin được. [Comment](https://github.com/digitopvn/studix/issues/91#issuecomment-6541889712).

## Câu hỏi còn mở

- Lỗi 8 cột đen ở 1080 chưa được tái hiện trên Studix. Phép thử này nằm trong tiêu chí Done của #90.
- Đề xuất `setHostHandlesSigterm` chưa được đăng lên `heygen-com/hyperframes`. Việc đó cần người có tài khoản làm.
