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
| Mã nguồn engine | `engine.json` → checkout `projects/wordcraft`, nhánh `aiword` của **Neurons-AI/wordcraft** (fork private của storytold/wordcraft, MIT/Apache) | sửa ở đây rồi build lại |
| Cầu nối | `apps/wordcraft-web/index.html` trong mã nguồn engine | postMessage ↔ trang, ngôn ngữ, chuyển lỗi engine ra trang |
| Backend | `backend/main.mjs` | `assist` (khung AI, `ctx.llm`), `open`/`save`/`readSheet` (chuyển đổi tệp cho agent) |
| Công cụ engine | `scripts/engine.mjs` | status · ensure · check · build [--bg] · build-status · ship · rollback · push · sync-app |
| Bản sao app trong repo | `aicw-app/` của Neurons-AI/wordcraft | `engine.mjs sync-app` cập nhật |

Ngôn ngữ giao diện theo `aicw.locale` (lệnh `ui.language`).

## Engine repair — khi AI Word gặp lỗi engine

Lỗi trong engine (Rust panic, WASM trap) hiện thanh đỏ "Bộ soạn thảo vừa gặp lỗi · Nhờ AI sửa" và ghi vào sổ lỗi của app
(AI Apps → Manage → Self-healing). Bấm nút → tin nhắn `[ai-word engine-bug] …` kèm JSON (message, stack, build, recentCommands).
Bộ sửa nhanh của nền tảng (`dev_app fix`, ≤ 8 tệp / 400 dòng, không đụng tệp nhị phân) KHÔNG sửa được engine: theo đúng
các bước dưới. App chạy từ thư mục này: `<app> = ~/aicoworker/openclaw/workspace-main/skills/ai-word`.

1. **Đọc trạng thái**: `node <app>/scripts/engine.mjs status` (nguồn, nhánh, build đang chạy, công cụ). Thiếu nguồn → `engine.mjs ensure`.
   Thiếu cargo/trunk/wasm32 → nói với chủ app, dừng (R8: không phải lỗi mã).
2. **Định vị**: message/stack chỉ crate + file (`crates/<crate>/src/…rs:line`). `recentCommands` = các lệnh vừa chạy → tái hiện.
   Đọc file đó trong checkout. Lỗi chỉ ở trang/backend (không có `panicked at`) → sửa bằng `dev_app fix` như app thường.
3. **Sửa nhỏ, đúng chỗ**: chỉ đổi Rust cần cho lỗi này (không refactor, không đổi API `window.wordcraft`, không đổi
   giao thức điều khiển). Giữ comment `AI Word:` ở chỗ sửa.
4. **Kiểm**: `cargo test -p <crate> <tên test gần nhất>` nếu crate có test chạm phần đó; rồi `node <app>/scripts/engine.mjs check` (phải ok).
5. **Build**: `node <app>/scripts/engine.mjs build --bg` (5–10 phút, chạy nền, sống qua lượt) → chờ bằng
   `exec({background:true})` `sleep 240 && node <app>/scripts/engine.mjs build-status` cho tới `state: done`. `failed` → đọc `errors`, quay lại 3.
6. **Hỏi chủ app** (`ask_user_question`): lỗi gì, sửa gì (vài dòng diff), build hash mới — "Cài bản sửa?". Không tự cài.
7. **Cài**: `node <app>/scripts/engine.mjs ship` (giữ bản cũ ở `.engine-backups/`), rồi
   `artifact {"action":"update","id":"app-ai-word","codePath":"skill:ai-word/assets/app.html"}`, chờ 20 s, xác minh
   (snapshot không còn "Loading AI Word…", chạy lại `recentCommands` qua `execute`, không còn thanh lỗi).
   Hỏng → `engine.mjs rollback` + update lại cửa sổ, báo chủ app.
8. **Lưu mã nguồn**: `node <app>/scripts/engine.mjs push "AI Word: fix <ngắn gọn>"` (commit + push nhánh `aiword`), rồi
   `node <app>/scripts/engine.mjs sync-app` nếu trang/backend cũng đổi.
9. Trả lời chủ app: nguyên nhân, đã sửa, hash build, commit.

Diễn tập lỗi (không có bug thật): trong trang, `AIWordEngineBug({kind:'panic',message:'panicked at test'})` hoặc gửi
`{__aiword:1,fn:'__testPanic'}` vào khung engine.

## Cập nhật engine từ upstream

`projects/wordcraft/MAINTAINING-AIWORD.md`: `git fetch upstream` → `main` fast-forward → rebase `aiword` → `engine.mjs check` →
`build` → hỏi → `ship` → `push`.

## Backend cho agent (không cần mở cửa sổ)

- `{"action":"call","id":"app-ai-word","name":"open","args":{"fileId":"<id>","name":"x.docx"}}` → `{ html }`
