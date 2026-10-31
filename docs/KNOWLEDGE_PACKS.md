# Knowledge pack

Knowledge pack là tri thức sáng tạo và kỹ thuật (camera, diễn xuất, motion, âm thanh, GL)
dạng dữ liệu có schema, để stage nạp khi cần. Pack không chứa code chạy. Pack nói nguồn của
nó, các phase sản xuất nó phục vụ, nội dung, và các check chứng minh sản phẩm làm đúng theo
nó. Quyết định nền: [ADR-0013](decisions/0013-hybrid-port-and-workflow-packs.md) ("Knowledge
pack chỉ được nạp bởi stage cần nó").

Status: **Implemented** trong `packages/skills/src/knowledge/`. Code là chuẩn; file này chỉ
giải thích cách dùng và cách thêm pack.

## Thành phần

| File                                                      | Vai trò                                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `knowledge/knowledge-pack-schema.ts`                      | Schema zod: `KnowledgePack`, `KnowledgeSource`, `HardCheck`, `EvidenceCheck` |
| `knowledge/knowledge-sources.ts`                          | SHA đã pin và helper tạo `sources` (`animeCreatorSource`, `agentkitSource`)  |
| `knowledge/knowledge-lint.ts`, `knowledge-lint-config.ts` | Lint pack và danh sách tên bị cấm                                            |
| `knowledge/knowledge-catalog.ts`                          | Catalog: đăng ký, nạp theo stage, tìm BM25, liệt kê hard check               |
| `knowledge/packs/*-pack.ts`                               | Một file một pack                                                            |
| `knowledge/builtin-knowledge-packs.ts`                    | Danh sách pack có sẵn                                                        |

Pack có sẵn: `narrative`, `performance`, `art-direction`, `dop-camera`, `wardrobe-props`,
`physics-lite`, `sound` (bảy pack của anime-creator), `production-failure-modes` (failure mode
đã đo trong `SKILL.md` nguồn), `creative-direction`, `voice-performance`, `motion-design`,
`motion-craft`, `composition-timing`, `shader-gl`, `threejs`, `signature-motion-styles` (40 style motion
đặt tên theo phong cách, không theo thương hiệu). Nguồn từng pack ghi trong trường
`sources` và trong [PORTING.md](PORTING.md#file-level-port-record-zuey-workspace-và-agentkit).

## Stage nạp pack

Stage khai báo pack nó cần bằng `knowledge` trong `StageDefinition` (`@studix/workflow`):

```ts
const keyframeStage: StageDefinition = {
  name: "anime.keyframe",
  knowledge: ["dop-camera", "performance", "production-failure-modes"],
  run: async (s) => {
    /* ... */
  },
};
```

- `loadStageKnowledge(stage)` trả đúng các pack đó theo thứ tự khai báo. Stage không có
  `knowledge` nhận danh sách rỗng.
- `registerPack` từ chối (VALIDATION) workflow pack có stage khai báo id knowledge chưa đăng
  ký, nên lỗi tên pack lộ ra lúc khởi động chứ không phải giữa job.
- `knowledgeCatalog.search(query, { phase, limit })` tìm BM25 trên mô tả pack và từng entry,
  lọc theo phase. Dùng khi planner cần gợi ý pack, không thay cho khai báo `knowledge`.

## Check: `hard` và `evidence`

Hai loại check không bao giờ gộp thành một điểm: một hard check trượt không được bù bằng
review tốt.

| Loại       | Ai quyết                           | Bắt buộc khai báo                                      |
| ---------- | ---------------------------------- | ------------------------------------------------------ |
| `hard`     | Tool đo bằng máy                   | `metric` (`id`, `unit`), `threshold`; `params` nếu cần |
| `evidence` | AI judge hoặc người xem bằng chứng | `judges` (`ai`, `human`), `evidence`, `pass`           |
- `metric.id` là contract cho tool QA (#44): tool đăng ký theo metric id, đo ra một số, và
  `meetsThreshold(check.threshold, value)` quyết pass. `knowledgeCatalog.hardChecks()` liệt kê
  mọi contract kèm pack của nó.
- Check có ngưỡng chủ sở hữu chưa duyệt mang `pendingReview` nêu dòng matrix (ví dụ ngưỡng
  lipsync 3 frame, AC-11).
- `judges: ["ai"]` một mình không đủ để duyệt; AI judge chỉ tạo bằng chứng cho người
  (matrix AC-29, AV-11). Duyệt của người dùng là `judges: ["human"]`.

## Tạo knowledge pack mới

1. **Kiểm tra matrix.** Thành phần nguồn phải có loại `pack:knowledge` trong
   [migration matrix](porting/migration-matrix.md). Dòng `human review` chỉ port khi chủ sở
   hữu đã duyệt; dòng `loại bỏ` không port.
2. **Đọc nguồn tại SHA đã pin**, chỉ bằng `git show <sha>:<path>` hoặc `git archive`, theo
   [quy trình sync](PORTING.md#quy-trình-sync-có-kiểm-soát).
3. **Tạo `packages/skills/src/knowledge/packs/<id>-pack.ts`**, export
   `const <name>Pack: KnowledgePack`. Id là kebab-case, `version` là semver; tăng version khi
   nội dung đổi.
4. **Ghi nguồn** bằng `animeCreatorSource(path, "AC-37")` hoặc `agentkitSource(path, "MD-01",
   notice?)`. Phần nguồn là MIT của bên thứ ba thì điền `notice` (ví dụ notice LottieFiles của
   `ak-motion-design`).
5. **Viết nội dung trung tính.** Viết lại bằng lời của mình, không chép đoạn dài hay code
   listing. Đổi tên phim, series, studio, nghệ sĩ còn sống và thương hiệu thành mô tả phong
   cách; tên thương hiệu không được làm id. Không có path máy, link cá nhân hay secret.
6. **Khai báo `phases`, `loadWhen`, `useCases`, `antiPatterns`, `sections`, `checks`.** Id check
   là `<pack-id>.<tên>`. Hard check chỉ dùng ngưỡng nguồn nêu rõ; còn lại là evidence.
7. **Thêm pack vào `BUILTIN_KNOWLEDGE_PACKS`**, rồi chạy `pnpm check`.
8. **Cập nhật** bảng port record trong [PORTING.md](PORTING.md) và ghi chú dòng matrix nếu
   loại hoặc đích thay đổi.

Pack ngoài danh sách có sẵn (ví dụ của một workflow pack thể loại) đăng ký bằng
`registerKnowledgePack(pack)`; catalog lint pack đó cùng các pack đã có trước khi nhận.

## Lint

`lintKnowledgePacks(packs, config?)` trả danh sách lỗi; rỗng là sạch. Test
`packages/skills/test/knowledge-packs.test.ts` lint mọi pack có sẵn, nên `pnpm test` và
`pnpm check` đỏ khi pack sai. Catalog cũng lint khi khởi tạo và khi `register`.

| Rule              | Bắt                                                                      |
| ----------------- | ------------------------------------------------------------------------ |
| `schema`          | Sai schema zod, kể cả hard check thiếu metric hay threshold              |
| `duplicate-pack`  | Id pack trùng                                                            |
| `duplicate-id`    | Id check trùng giữa mọi pack; id section hoặc entry trùng trong một pack |
| `check-prefix`    | Id check không bắt đầu bằng `<pack-id>.`                                 |
| `unpinned-source` | `sources[].ref` không ở SHA đã pin của repo đó                           |
| `absolute-path`   | Path ổ đĩa, UNC, `~/` hoặc root POSIX tuyệt đối trong nội dung           |
| `secret`          | Chuỗi trông như key, token hoặc private key                              |
| `banned-term`     | Tên trong `bannedTerms` (không phân biệt hoa thường, theo ranh giới từ)  |

Danh sách tên bị cấm nằm ở `DEFAULT_BANNED_TERMS` trong `knowledge-lint-config.ts`; truyền
`{ ...DEFAULT_KNOWLEDGE_LINT_CONFIG, bannedTerms: [...] }` để đổi. Lint bỏ qua `sources`, vì ref
là path thật của nguồn (ví dụ thư mục skill mang tên provider). Từ tiếng Anh thông dụng trùng
tên thương hiệu không nằm trong danh sách mặc định; reviewer bắt các trường hợp đó.
