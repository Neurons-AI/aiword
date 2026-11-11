---
name: ai-word
description: "AI Word — trình soạn thảo kiểu MS Word (giao diện ribbon y như Word) trong AICoworker, có trợ lý AI viết/sửa/dịch/tóm tắt. Mở/lưu .docx .doc .odt .rtf .html .md .tex .txt, xuất PDF; theo dõi thay đổi, mục lục, chú thích, trộn thư. Dùng khi người dùng muốn soạn, mở, sửa tài liệu Word, hoặc khi AI Word báo lỗi engine ([ai-word engine-bug]) cần sửa."
---

# AI Word

Mở cửa sổ: `artifact` `{"action":"create","app":"ai-word"}`.

## Cấu tạo

| Phần | Ở đâu | Là gì |
|---|---|---|
| Trang | `assets/app.html` | khung engine + khung ✨ AI + thanh lỗi engine |
| Engine | `assets/wordcraft/` (build, ~60 MB, KHÔNG sửa tay) | Rust WordCraft → WebAssembly. `window.wordcraft`: `execute(command, params)`, `request`, `commands({search})`, `docInspect`, `uiInspect`, `screenshot` (675 lệnh) |
| Mã nguồn engine | `engine.json` → checkout `projects/wordcraft`, nhánh `aiword` của **Neurons-AI/aiword** (fork private của storytold/wordcraft, MIT/Apache) | sửa ở đây rồi build lại |
| Cầu nối | `apps/wordcraft-web/index.html` trong mã nguồn engine | postMessage ↔ trang, ngôn ngữ, chuyển lỗi engine ra trang |
| Backend | `backend/main.mjs` | `assist` (khung AI, `ctx.llm`), `open`/`save`/`readSheet` (chuyển đổi tệp cho agent) |
| Công cụ engine | `scripts/engine.mjs` | status · ensure · check · build [--bg] · build-status · ship · rollback · push · sync-app |
| Bản sao app trong repo | `aicw-app/` của Neurons-AI/aiword | `engine.mjs sync-app` cập nhật |

Ngôn ngữ giao diện theo `aicw.locale` (lệnh `ui.language`).

## Engine repair — khi AI Word gặp lỗi engine (chạy được trên máy BẤT KỲ, kể cả người mua từ Store)

Engine (Rust panic, WASM trap) lỗi → trang tự gọi `reportEngineBug` → backend gửi ngay cho agent tin nhắn
`[ai-word engine-bug] …` kèm JSON (message, stack, build, recentCommands). Người dùng KHÔNG cần bấm gì; thanh đỏ chỉ báo
"AI đang sửa". Mỗi lỗi chỉ gửi 1 lần trong 6 giờ. Bộ sửa nhanh của nền tảng (`dev_app fix`) KHÔNG sửa được engine
(tệp nhị phân 57 MB) — làm đúng các bước dưới. `<app>` = thư mục app này (nơi có SKILL.md); mọi lệnh trả 1 dòng JSON `{ok,…}`.
Người dùng có thể không rành kỹ thuật: hỏi họ đúng **một** câu có/không (bước 2), nói bằng lời thường, không bắt họ gõ lệnh.

1. **Trạng thái**: `node <app>/scripts/engine.mjs status` → `missing` liệt kê cái thiếu (nguồn, Rust, trunk).
2. **Xin phép 1 lần** (`ask_user_question`, có/không): "AI Word vừa gặp lỗi <tóm tắt 1 câu>. Cho em tự sửa nhé? Lần đầu
   cần tải bộ công cụ ~1 GB (khoảng 10–20 phút), sau đó em sẽ sửa, biên dịch lại và cài bản mới; bản cũ được giữ để
   quay lại nếu có vấn đề." Không đồng ý → dừng, nói họ có thể bấm lại "Nhờ AI sửa" sau. Đồng ý = cho phép cả tải công
   cụ, sửa, biên dịch VÀ cài (không hỏi lại ở bước 7).
3. **Chuẩn bị** (chỉ khi `missing` có): `engine.mjs toolchain` (Rust + wasm32 + trunk vào `<app>/data/engine/toolchain`,
   không cần quyền admin, không đụng hệ thống) rồi `engine.mjs ensure` (tải nguồn công khai Neurons-AI/aiword + craft-i18n;
   có git thì clone, không có thì tải tarball). Lỗi mạng → thử lại 1 lần, vẫn lỗi → báo người dùng, dừng.
4. **Định vị**: message/stack chỉ crate + file (`crates/<crate>/src/…rs:line`); `recentCommands` = lệnh vừa chạy để tái hiện.
   Đọc file đó trong `source` (đường dẫn trong `status`). Lỗi ở trang/backend (không có `panicked at`/`unreachable`) → sửa bằng
   `dev_app fix` như app thường.
5. **Sửa nhỏ, đúng chỗ**: chỉ dòng Rust cần cho lỗi này (không refactor, không đổi API `window.wordcraft`, không đổi giao thức
   điều khiển). Ghi comment `AI Word:` ở chỗ sửa. Rồi `engine.mjs check` (phải ok; lỗi → đọc `errors`, sửa lại, tối đa 4 vòng).
6. **Build**: `engine.mjs build --bg` (5–15 phút, chạy nền, sống qua lượt) → chờ bằng `exec({background:true})`
   `sleep 240 && node <app>/scripts/engine.mjs build-status` tới `state: done`. `failed`/`died` → đọc `errors`, quay lại 5.
7. **Cài** (đã được phép ở bước 2): `engine.mjs ship` (bản cũ giữ ở `.engine-backups/`), rồi
   `artifact {"action":"update","id":"app-ai-word","codePath":"skill:ai-word/assets/app.html"}`, chờ 20 s, xác minh: chạy lại
   `recentCommands` trong khung (artifact `act` eval `AIWordHost.waitWc().then(api=>api.execute(cmd,params))`), không còn thanh lỗi.
   Hỏng → `engine.mjs rollback` + update lại cửa sổ, báo người dùng.
8. **Lưu mã nguồn**: chỉ khi `status.canPush` = true (máy của người bảo trì, có quyền ghi repo): `engine.mjs push "AI Word: fix …"`.
   Máy người mua: bỏ qua; bản sửa vẫn nằm trong app của họ.
9. Báo người dùng bằng lời thường: lỗi gì, đã sửa, đã cài; nếu có, commit.

Diễn tập (không có bug thật): trong trang `AIWordEngineBug({kind:'panic',message:'panicked at test'})`.
Kiểm tra máy trắng: `AIWORD_DATA=/tmp/x HOME=/tmp/x node <app>/scripts/engine.mjs toolchain` → `ensure` → `build`.

## Cập nhật engine từ upstream

`MAINTAINING-AIWORD.md` trong repo Neurons-AI/aiword: `git fetch upstream` → `main` fast-forward → rebase `aiword` → `engine.mjs check` →
`build` → hỏi → `ship` → `push`.

## Backend cho agent (không cần mở cửa sổ)

- `{"action":"call","id":"app-ai-word","name":"open","args":{"fileId":"<id>","name":"x.docx"}}` → `{ html }`
