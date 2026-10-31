# 0014. Storyboard, revision scene/shot, stage cache và pack registry

- Status: Accepted
- Date: 2026-10-31

## Context

[ADR 0013](0013-hybrid-port-and-workflow-packs.md) quyết định port theo pack trên
một engine dùng chung. Issue [#43](https://github.com/digitopvn/studix/issues/43)
cần các contract mà mọi pack dựa vào trước khi port nội dung:

- Nguồn có ba danh sách shot chồng nhau (EDL, `action-plan.json`, `filmspec.json`)
  và hai kiểu storyboard (AC-07, FM-06, AV-04 trong
  [migration matrix](../porting/migration-matrix.md)).
- Sửa một shot không được làm sinh lại và trả tiền lại cho cả video. `ProjectVersion`
  lưu cả IR, nên không biết phần nào đã đổi.
- Motion graphic dựng bằng code (GL, HyperFrames) cần nằm trong VideoIR mà IR vẫn
  khai báo và độc lập renderer.
- Renderer (#42) cần một shape audio đa kênh.
- Stage hiện nhận `payload` không kiểu; không có cách nói "cùng input thì không chạy lại".
- MCP server đọc danh sách skill từ `@studix/skills`; thêm thể loại không được đòi sửa server.

## Decision

1. **`Storyboard` trong `@studix/video-ir`** (zod, có JSON Schema): character
   (asset tham chiếu, voice), asset, beat (dialogue), scene, shot (`kind` dùng chung
   `ShotType`, `dependsOn` cho continuity) và `approval` ở ba cấp storyboard, scene,
   shot. Validator bắt tham chiếu lạ, id trùng và chu trình continuity.
2. **Invalidation bằng Merkle digest.** `videoIrNodes` và `storyboardNodes` mô tả
   tài liệu thành đồ thị phụ thuộc; `nodeDigests` băm JSON chuẩn hóa của node cùng
   digest các phụ thuộc. Node bị invalidate đúng khi chính nó hoặc một phụ thuộc
   đổi. Trạng thái duyệt không nằm trong digest.
3. **Revision bất biến cạnh `ProjectVersion`.** Bảng `ir_node_revisions` lưu mỗi
   scene/shot theo `(project, kind, node, digest)`; `project_version_nodes` nối
   version với revision. Digest đã có thì dùng lại revision cũ (quay lại nội dung cũ
   trỏ về revision cũ). `asset_lineage` ghi asset version sinh ra từ revision hay từ
   asset version nào; `derivedAssetVersions` truy vết bắc cầu những gì hết hạn.
4. **Shot `composition`** trỏ tới asset loại `code` bằng `assetId`, kèm `entry` và
   `params` phẳng. Asset phải có `assetVersionId` (lỗi `unpinned_code`). Renderer tự
   báo hỗ trợ qua `supports()`; HyperFrames hiện báo chưa hỗ trợ.
5. **Audio track đa kênh**: `kind` (`dialogue`, `voiceover`, `music`, `sfx`),
   `startMs`, `durationMs?`, `trimStartMs?`, `volume` 0..1, `gainDb?` -60..12 (cộng
   thêm trên volume), `fadeInMs?`, `fadeOutMs?` (tổng không vượt `durationMs`).
   Các trường mới là optional nên `schemaVersion` không tăng.
6. **`StageDefinition` có `inputSchema`, `outputSchema`, `cacheKey`.** Runner parse
   `{payload, outputs}` thành `stage.input`; lỗi là VALIDATION không retry. Khi runner
   có `stageCache` và stage trả `cacheKey`, một entry hợp lệ của cùng tenant được ghi
   thành checkpoint (qua `writeStage` có fencing) và stage không chạy, không qua
   approval, không check budget, không ghi usage. Kết quả mới chỉ vào cache sau khi
   checkpoint fenced thành công, nên worker mất lease không công bố kết quả.
   `stageCacheKey(stage, version, input)` là key chuẩn; bảng `stage_cache` unique theo
   `(org, workspace, stage, cache_key)`, ghi đầu tiên thắng.
7. **Pack registry trong `@studix/skills`.** `WorkflowPack` gồm template và stage.
   `registerPack` là cách duy nhất để thêm thể loại; MCP server và worker chỉ đọc
   registry. `brand-intro` thành pack đầu tiên, có stage `brand-intro.compose`.

## Consequences

- Patch một shot chỉ chạy lại và tính phí stage của shot đó cùng các node phụ thuộc
  (scene chứa nó, document); phần còn lại lấy từ cache. Có test unit cho điều này
  trong `packages/workflow/test/stage-cache.test.ts`.
- Cache theo tenant: hai workspace không bao giờ thấy output của nhau, đổi lại không
  chia sẻ chi phí giữa tenant.
- Stage chỉ được khai báo `cacheKey` khi output di động (không có đường dẫn cục bộ
  của worker).
- Thêm một loại shot vào union buộc mọi renderer xử lý nó; HyperFrames có thêm một
  nhánh từ chối.

## Alternatives considered

- **Diff JSON giữa hai version** để tìm phần đổi: không thấy được phụ thuộc gián
  tiếp (đổi asset hay brand làm đổi shot dùng nó).
- **Cache theo job** thay vì theo tenant: không tái dùng được giữa các job sinh từ
  patch, là trường hợp chính của #43.
- **Shot composition chứa code inline**: làm IR không còn khai báo và không pin
  được version.
