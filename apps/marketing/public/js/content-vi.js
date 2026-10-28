/* Vietnamese copy for the Motion MCP landing. Loaded before site.js; mirrors the keys of content-en.js. */
window.SITE_CONTENT = (() => {
const samples = [ // id, name, aspect, seconds, film, brief, note, bento span
  ["SC 01", "Ra mắt sản phẩm", "16:9", "9.5 s", "launch", "Teaser ra mắt Quiet Hours, app hẹn giờ tập trung. Điềm tĩnh, chất biên tập, hơi tự đắc về sự im lặng.", "", "c4"],
  ["SC 02", "Reel mạng xã hội", "9:16", "8.2 s", "kinetic", "Chẳng ai đọc hướng dẫn sử dụng, nên cho nó chuyển động đi. Ồn ào, tinh nghịch.", "", "c2"],
  ["SC 03", "Quảng cáo địa phương", "4:5", "9.5 s", "bakery", "Quảng cáo lớp làm bánh mì chua cuối tuần. Ấm áp, gần gũi, tiếng Việt.", "Brief và render hoàn toàn bằng tiếng Việt. Dấu đầy đủ, không tính thêm phí.", "c2"],
  ["SC 04", "Câu chuyện dữ liệu", "16:9", "9.0 s", "data", "Câu chuyện dữ liệu về thói quen uống cà phê của dân lập trình. Hài kiểu mặt lạnh, biểu đồ tông tối chất biên tập.", "", "c4"],
  ["SC 05", "Thiệp mời", "1:1", "9.0 s", "event", "Thiệp mời vuông cho tiệc tất niên công ty. Sang trọng, có chút tinh quái.", "", "c3"],
  ["SC 06", "Video giải thích", "16:9", "9.5 s", "explainer", "Video giải thích kỹ thuật: một lệnh gọi MCP biến brief thành video hoàn chỉnh như thế nào. Phong cách bản vẽ kỹ thuật.", "", "c3"],
];
const steps = [ // number, role, title, body, aside
  ["01", "Bạn", "Viết brief", "Nói điều bạn cần, bằng lời thường. “Teaser ra mắt nhẹ nhàng, không dùng gradient” là đủ.", "Tiếng Việt cũng được."],
  ["02", "Đạo diễn", "Định gu", "Một model hàng đầu (Claude Opus) quyết định câu chuyện, nhịp, chữ và màu. Model này đắt, nên chỉ được gọi khi cần đến gu.", "Nó không viết code. Đã có người khác lo."],
  ["03", "Ê-kíp", "Dựng từng cảnh", "Code và các model nhỏ, nhanh biến kế hoạch thành từng cảnh. Một nhà sản xuất (Jev) quyết định ai sửa gì, và có đáng bỏ tiền ra sửa hay không.", "Rẻ ở chỗ có thể rẻ, khôn ở chỗ cần khôn."],
  ["04", "Biên tập", "Kiểm tra, rồi render", "Mọi cảnh đều được kiểm tra từng khung hình trước khi render bản cuối.", "Bạn nhận một file MP4 sẵn sàng cho web và một link để chia sẻ."],
];
const briefs = ["Làm teaser dọc 10 giây cho lớp làm bánh mì thứ Bảy của tôi. Ấm áp, thân thiện, tiếng Việt.", "Teaser ra mắt nhẹ nhàng, không dùng gradient.", "Thiệp mời vuông cho tiệc tất niên. Sang trọng, có chút tinh quái."];
const compare = [
  ["Chữ trên màn hình", "Chữ chảy nhoè, chính tả sáng tạo", "Typography thật, đúng chính tả mọi lần"],
  ["Sửa một chi tiết", "Tạo lại toàn bộ rồi cầu may", "Nói chỗ cần sửa. Chỉ cảnh đó được dựng lại."],
  ["Thương hiệu của bạn", "Màu “na ná là được”", "Đúng màu thương hiệu, chữ sắc nét, lần render nào cũng như nhau"],
  ["Chi phí", "Model lớn cho mọi bước", "Model lớn chỉ dùng cho gu. Việc vặt để code lo."],
  ["Chuyện gì đã xảy ra", "Một hộp đen", "Từng bước và chi phí của nó, hiện rõ trong dashboard"],
];
const chat = [ // role, html, pause before (ms)
  ["you", "Làm teaser dọc 10 giây cho lớp làm bánh mì thứ Bảy của tôi. Ấm áp, thân thiện, tiếng Việt.", 300],
  ["ai", "Có ngay. Mình đã gửi brief cho Motion MCP, duyệt các khung hình xem trước và yêu cầu render bản cuối.<br/><code>motion_create → motion_render</code><br/>MP4 của bạn đây, 1080 × 1920. Bạn có muốn chữ ngày tháng to hơn không?", 800],
  ["you", "Có. Và làm nó ấm cúng hơn chút nhé.", 1300],
  ["sys", "Chỉ cảnh có ngày tháng được dựng lại. Phần còn lại giữ nguyên như bạn đã duyệt.", 900],
];
const tools = [
  ["motion_create", "Bắt đầu một video từ brief, hoặc từ creative spec do chính model của bạn viết."],
  ["motion_edit", "Chỉnh sửa bằng lời thường hoặc bằng scene patch có kiểu."],
  ["motion_inspect", "Schema, chế độ đạo diễn, bảng giá và giới hạn trong một lệnh gọi."],
  ["motion_render", "Bản nháp xem trước, hoặc bản cuối khi mọi bước kiểm tra đều qua."],
  ["motion_search", "Phong cách, kiểu cảnh quay, công thức và các dự án cũ."],
  ["motion_get_project", "Tiến độ, phiên bản, bản render, mức dùng và chi tiết chi phí."],
  ["motion_list_projects", "Duyệt qua workspace của bạn."],
  ["motion_publish", "Link chia sẻ cố định, ẩn danh sách hoặc công khai."],
];
const prices = [
  ["Trợ lý của bạn đạo diễn", "32", "credit", "Chi phí của mỗi mẫu 10 giây ở trên khi trợ lý gọi tới tự viết kế hoạch sáng tạo."],
  ["Đạo diễn của chúng tôi", "~130", "credit", "Thêm một lệnh gọi tới đạo diễn sáng tạo của chúng tôi, 100 credit, khi bạn chỉ gửi brief."],
  ["Truy cập sớm", "5.000", "credit miễn phí", "Mọi tài khoản mới bắt đầu với 5.000 credit. Gói nạp trả phí sẽ có sau. Giờ thì cứ làm đi đã.", true],
];
const faq = [
  ["Tôi có cần biết code hay dựng video không?", "Không. Bạn mô tả video bằng lời thường, với trợ lý AI hoặc ngay trong dashboard. Phần code và dựng phim diễn ra phía sau."],
  ["Nó làm được những loại video nào?", "Motion graphics: teaser ra mắt, video giải thích, reel mạng xã hội, câu chuyện dữ liệu, thiệp mời và thông báo, ở tỉ lệ 16:9, 9:16, 1:1 hoặc 4:5. Nó dựng chữ, hình khối, con số và code trên màn hình. Nó không quay người thật và không tạo cảnh quay giống ảnh chụp."],
  ["Nếu tôi không ưng kết quả thì sao?", "Nói chỗ cần đổi: “ngày to hơn”, “cảnh hai chậm lại”, “màu ấm hơn”. Chỉ những cảnh liên quan được dựng lại, phần bạn đã ưng vẫn giữ nguyên."],
  ["Tôi có thể tải về và đăng video không?", "Có. Mọi bản render cuối là file MP4 sẵn sàng cho web, bạn có thể tải về hoặc chia sẻ qua link cố định từ dashboard."],
  ["Tôi có thể chạy trên server của mình không?", "Có. Toàn bộ hệ thống là mã nguồn mở theo giấy phép MIT. Dùng key model của riêng bạn, và có thể tắt hẳn phần tính phí."],
];
const ui = {
  introTitle: "Giới thiệu Motion MCP", watchFilm: "Xem phim ↗", you: "Bạn", assistant: "Trợ lý của bạn",
  copy: "Sao chép", copied: "Đã chép", startFree: "Dùng miễn phí", video: "Video", showVideo: "Xem video",
  soundOn: "Bật âm thanh", soundOff: "Tắt âm thanh", locale: "vi-VN",
  filters: { All: "Tất cả", Motion: "Motion", Product: "Sản phẩm", Reels: "Reels", Story: "Câu chuyện" },
};
return { samples, steps, briefs, compare, chat, tools, prices, faq, ui };
})();
