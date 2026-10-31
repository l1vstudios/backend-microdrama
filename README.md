# Morai Backend

Bun + Hono + Postgres backend untuk Morai. AI upstream default memakai Google AI Studio / Gemini API.

```bash
cd ../morai-backend
bun install
bun run migrate
bun run bridge
```

Backend membaca `.env` lokal folder ini, fallback `../morai/.env`, lalu `~/.hermes/.env`. Pakai salah satu key berikut:

```txt
GOOGLE_AI_STUDIO_API_KEY=...
GEMINI_API_KEY=...
GOOGLE_API_KEY=...
```

Endpoint default:

```txt
http://localhost:8788
```

## Drado Director Studio

Backend default sekarang **127.0.0.1:8788** agar tidak berbenturan dengan Caveman proxy pada 8787. Binding hanya loopback untuk workspace lokal. `HOST` dapat diatur bila diperlukan dalam deployment dengan akses yang sesuai.

UI **DRADO AI** mewajibkan login sebelum dashboard dibuka. Akun admin sementara default adalah **admin / admin**, diperiksa oleh backend. Override melalui `DRADO_ADMIN_USERNAME` dan `DRADO_ADMIN_PASSWORD`; `DRADO_SESSION_DAYS` mengatur masa sesi (default 7 hari). Satu akun ini mengakses workspace bersama. Autentikasi Drado tidak memerlukan Postgres dan tidak menggunakan endpoint akun legacy `/api/auth/*`.

- `POST /api/drado/auth/login` — JSON `{username, password}`, membuat cookie sesi HttpOnly dengan SameSite=Lax.
- `GET /api/drado/auth/me` — memeriksa sesi aktif, mengembalikan 401 bila belum login.
- `POST /api/drado/auth/logout` — mencabut sesi aktif dan menghapus cookie.

Seluruh endpoint Drado lainnya, termasuk status, skill, proyek, usage, dan file media, memerlukan cookie sesi. Token acak disimpan sebagai hash pada `storage/drado/auth.sqlite`; sesi tetap tersedia setelah restart sampai kedaluwarsa, logout, atau kredensial admin berubah. Restart backend manual untuk menerapkan perubahan.

Gunakan proxy `/api` pada origin frontend yang sama, seperti konfigurasi Vite yang tersedia. Request API frontend mengikutsertakan cookie dan file image/video menggunakan cookie yang sama. Untuk HTTPS melalui reverse proxy, atur `DRADO_COOKIE_SECURE=1`.

Endpoint `/api/drado` menjalankan skill Hermes `drado-agent` dengan provider `nous` dan model `openai/gpt-5.5`. Override dengan `DRADO_PROVIDER`, `DRADO_MODEL`, `HERMES_BIN`, `DRADO_TIMEOUT_MS` (default 600000). `DRADO_SKILL_PATH` dipakai untuk pemeriksaan kesiapan instalasi skill; nama skill yang dimuat tetap `drado-agent`.

Pilihan engine tersimpan per proyek sebagai `engines: {script: 'hermes'|'gemini', image: 'hermes'|'gemini'}`. Default proyek lama adalah script Hermes dan image Gemini. `POST /sessions` menerima `engines`, dan `PATCH /sessions/:id` dapat mengubah `title` dan/atau `engines`; perubahan engine ditolak selama script atau generasi media proyek berjalan. `GET /api/drado/engines` mengembalikan pilihan, model, serta kesiapan konfigurasi lokal tanpa memanggil provider. Kesiapan lokal Hermes image belum memverifikasi login atau kuota ChatGPT; autentikasi diperiksa ketika generate.

Script Gemini memakai [generateContent](https://ai.google.dev/api/generate-content) dengan API key Google yang tersedia. Model mengikuti `DRADO_GEMINI_SCRIPT_MODEL`, fallback model teks Google yang sudah dikonfigurasi. Isi skill `drado-agent`, referensi storyboard/T2V, serta skill Caveman aktif dimasukkan sebagai instruksi; tool/subprocess Hermes tidak dijalankan pada jalur script Gemini. Jawaban baru mencatat `message.engine` dan skill/instruksi yang dipakai.

Kontrak output bersama pada `drado-output-rules.ts` mengarahkan catatan produksi, revisi, dan checklist continuity/QA menjadi tabel Markdown GFM dengan kolom `Shot / Aset | Aspek | Catatan produksi | Status`. Kedua runner menerima aturan ini dari `buildDradoPrompt`. Request khusus catatan tidak meminta ulang casting atau seluruh prompt, dan status yang belum diperiksa tidak boleh dianggap disetujui. Prompt image/video tetap dalam fenced code block terpisah. Aturan ini berlaku untuk request berikutnya setelah restart backend; riwayat tersimpan tidak ditulis ulang.

Image Hermes memakai plugin native `plugins/image_gen/openai-codex` melalui Python Hermes, dengan akun ChatGPT Hermes (`hermes auth add openai-codex`). Tidak mengubah konfigurasi global Hermes dan tidak memerlukan Gemini API key. Model default `gpt-image-2-medium`; override `DRADO_HERMES_IMAGE_MODEL` mendukung `gpt-image-2-low`, `gpt-image-2-medium`, atau `gpt-image-2-high`. Bridge membaca interpreter dari launcher Hermes; lokasi dapat diatur melalui `DRADO_HERMES_ROOT` dan `DRADO_HERMES_PYTHON` bila instalasi berbeda. Interpreter tersebut memerlukan dependensi plugin Hermes serta Pillow.

Bridge mengimpor `hermes_bootstrap` sebelum Pillow/plugin agar dependency generation Hermes yang aktif ikut dimuat; interpreter dasar launcher sendiri tidak memuat paket Hermes. Error dependensi diteruskan dengan nama modul, dan kegagalan provider dengan status HTTP bila tersedia. Log `[drado:hermes-image]` hanya berisi kode error, status, dan nama modul, tanpa token atau isi respons upstream. Tidak ada pengulangan generate otomatis saat gagal.

Image Hermes mengirim maksimal 16 referensi master lokal melalui plugin, menyimpan hasil PNG dalam library Drado, dan mencatat `job.engine`. Bridge meminta ukuran sesuai rasio; bila provider native mengembalikan rasio berbeda, hasil dipotong dari tengah ke rasio yang dipilih sebelum disimpan. Video tetap Gemini Omni, dengan keyframe dari salah satu engine image. Biaya ChatGPT OAuth yang tidak dilaporkan plugin diberi status unavailable, bukan nol, dan dikecualikan dari panel `/media/usage` khusus Gemini. Tidak ada fallback otomatis antar-provider atau pengulangan request berbayar.

Caveman aktif secara default untuk percakapan Drado (`DRADO_CAVEMAN=1`; gunakan `0` untuk menonaktifkan). Hermes memuat skill `caveman` jika tersedia, dengan instruksi tambahan untuk mengurangi basa-basi dan pengulangan. Prompt produksi, dialog, continuity, dan format heading UI tetap harus lengkap. Provider/model tetap mengikuti `DRADO_PROVIDER` dan `DRADO_MODEL`; koneksi tidak dialihkan ke proxy Caveman.

Riwayat yang cukup besar dikemas secara lokal dengan `caveman-engine toon encode`, lalu didekode kembali untuk memastikan setiap role dan isi pesan identik sebelum digunakan. TOON hanya dipakai jika ukuran byte lebih kecil setelah memperhitungkan overhead format. Jika engine tidak tersedia, format tidak valid, atau hasil tidak lebih kecil, backend memakai JSON asli. Riwayat SQLite dan prompt image/video tidak diubah. Log `[drado:caveman] history bytes ...` melaporkan byte input, bukan token provider atau penghematan tagihan. Tidak ada janji persentase penghematan.

Lokasi default engine: `~/.caveman/bin/caveman-engine` (override `CAVEMAN_ENGINE_BIN`). Lokasi skill: `~/.hermes/skills/productivity/caveman/SKILL.md` (override `DRADO_CAVEMAN_SKILL_PATH`, untuk pengecekan instalasi; skill tetap dimuat dengan nama `caveman`). `GET /api/drado/status` menyediakan status konfigurasi dan ketersediaan engine/skill tanpa memanggil model. Restart backend manual setelah perubahan konfigurasi.

Percakapan disimpan di SQLite pada `storage/drado/sessions.sqlite` (override direktori: `DRADO_STORAGE_DIR`). Drado tidak memerlukan migrasi Postgres; endpoint lama tetap menggunakan Postgres. Proyek yang terputus saat backend restart ditandai gagal sehingga dapat dicoba ulang tanpa menggandakan pesan.

- `GET /api/drado/engines` — opsi script/image, model, dan kesiapan konfigurasi.
- `GET /api/drado/status` — kesiapan Hermes dan skill.
- `GET /api/drado/skills` — skill yang dimuat otomatis oleh bridge, beserta deskripsi, versi jika tersedia, dan status aktif/nonaktif/belum tersedia. Menggunakan sumber konfigurasi yang sama dengan argumen `--skills` Hermes. Respons juga berisi `capabilities` yang dicocokkan dengan bagian skill Drado terpasang, `references` untuk storyboard/T2V, dan `supportingSkills` untuk ketersediaan cinematic lighting, window light, serta rack focus. Ketersediaan skill pendukung tidak berarti skill itu dimuat pada setiap request. Jawaban baru menyimpan nama skill yang dimuat di field `message.skills`; riwayat lama tidak diisi dengan asumsi.
- `GET /api/drado/media/usage` — jumlah generasi image/video beserta 50 job terbaru dan estimasi biaya USD, tanpa isi prompt atau API key. Jumlah mencakup status berjalan, selesai, dan gagal. Ledger biaya tetap tersedia setelah proyek dihapus; hasil proyek yang dihapus tidak ditautkan.
- `GET|POST /api/drado/sessions` — daftar / buat proyek.
- `GET|PATCH|DELETE /api/drado/sessions/:id` — baca / ubah nama / hapus.
- `PATCH /api/drado/sessions/:id/messages/:messageId` — simpan edit prompt assistant `{expectedContent, content}`. Sumber harus sama dengan versi tersimpan; konflik versi atau proses chat/media aktif mengembalikan 409. Perubahan disimpan di SQLite dengan `editedAt` dan tidak memanggil model.
- `DELETE /api/drado/sessions/:id/messages/:messageId` — JSON `{expectedContent}`, hapus satu pesan user/assistant beserta record media terkait. Menolak pesan yang berubah atau proyek dengan script/media aktif. Pesan hilang dari konteks chat dan ekspor; ledger biaya tetap tersimpan dengan tautan hasil dinonaktifkan. Cache file fisik mengikuti kebijakan penyimpanan yang sama dengan hapus proyek.
- `POST /api/drado/sessions/:id/messages` — `{content}` atau `{retry:true}`, mengembalikan 202; polling GET session untuk hasil.
- `POST /api/drado/sessions/:id/cancel` — hentikan subprocess.

`bun test drado.test.ts` menguji history, persistensi, validasi, pembatalan, retry dan isolasi konteks. Test menggunakan runner palsu tanpa memanggil provider berbayar.

Untuk origin frontend tambahan, daftarkan melalui `DRADO_ALLOWED_ORIGINS=https://studio.example.com` (beberapa origin dipisahkan koma), serta `CORS_ORIGIN` bila nilainya tidak `*`. Localhost/127.0.0.1 sudah diizinkan. Cookie SameSite=Lax memerlukan frontend dan API pada site yang sama; gunakan proxy `/api` untuk deployment lintas domain.

Biaya generasi dicatat pada tabel `media_costs` di `generated.sqlite`, dengan satu baris per job agar polling Interactions API tidak menggandakan biaya. Tarif disalin ke job saat generasi dimulai dan tidak dihitung ulang menggunakan tarif terbaru. Usage API disimpan sebelum penulisan file, sehingga kegagalan menyimpan hasil tidak menghilangkan biaya yang sudah dapat dihitung. Nilai disimpan dalam satuan sepersejuta USD, lalu dijumlahkan untuk image, video, dan total. Hapus proyek tetap mempertahankan ledger biaya tanpa prompt atau file gambar/video.

Tarif default mengikuti [harga Standard Google](https://ai.google.dev/gemini-api/docs/pricing), diperiksa 16 Oktober 2026: `gemini-3-pro-image` input $2, text/thinking output $12, image output $120 per sejuta token; `gemini-omni-1.1-flash` dan `gemini-omni-flash-preview` input $1.50, text/thinking output $9, video output $17.50 per sejuta token. Input mencakup token referensi gambar; output memakai rincian modalitas respons. Estimasi belum termasuk pajak, kredit, dan diskon akun. Data lama tanpa usage, usage belum final/lengkap, cache/tool yang belum memiliki tarif, atau model dengan tarif belum dikonfigurasi diberi biaya `null`, bukan nol. Total menyertakan jumlah generasi yang belum terhitung.

Untuk memperbarui tarif atau memakai model/provider lain, isi ketiga tarif untuk setiap jenis di `.env` (USD per sejuta token). Override parsial tidak dipakai agar tidak mencampur tarif model berbeda:

```dotenv
DRADO_IMAGE_INPUT_USD_PER_MILLION=2
DRADO_IMAGE_TEXT_OUTPUT_USD_PER_MILLION=12
DRADO_IMAGE_MEDIA_OUTPUT_USD_PER_MILLION=120
DRADO_VIDEO_INPUT_USD_PER_MILLION=1.5
DRADO_VIDEO_TEXT_OUTPUT_USD_PER_MILLION=9
DRADO_VIDEO_MEDIA_OUTPUT_USD_PER_MILLION=17.5
```

Tarif default hanya digunakan untuk model yang dikenali melalui host Google resmi. Tidak ada request billing Google atau generasi tambahan untuk menghitung biaya. Riwayat sebelum fitur ini tidak diisi dengan perkiraan jumlah token atau harga per gambar yang dibuat-buat.


## Generate image & video dari UI

`/api/drado/sessions/:id/media` menyimpan job generasi asinkron per pesan dan target. `POST` mengembalikan 202; UI polling `GET` untuk hasil. File hasil tersedia di `/:mediaId/content`, dengan `?download=1` untuk unduh.

Generate image baru selalu memakai HD (`imageSize: "1K"`), termasuk request lama yang omit ukuran atau mengirim Auto/2K. Gemini meneruskannya ke `generationConfig.imageConfig.imageSize` sesuai [dokumentasi image generation](https://ai.google.dev/gemini-api/docs/image-generation). Hermes meminta sisi terpanjang 1024 piksel sesuai rasio: 1:1 = 1024×1024, 16:9 = 1024×576, 9:16 = 576×1024, 4:3 = 1024×768, dan 3:4 = 768×1024. Job mencatat ukuran aktual Hermes dan status upscale. Resolusi video `720p`/`1080p` terpisah dari ukuran image.

- Image: `gemini-3-pro-image` (Nano Banana Pro) melalui `generateContent`, override `DRADO_IMAGE_MODEL`.
- Video: `gemini-omni-1.1-flash` melalui `/interactions`, override `DRADO_VIDEO_MODEL`. Input berupa keyframe shot dan prompt video. Jalur Drado ini tidak memakai Veo.
- Autentikasi menggunakan Gemini/Google API key yang sudah dibaca backend. API key tidak dikirim ke browser.
- Media tersimpan di `storage/drado/generated/`, metadata di `storage/drado/generated.sqlite`. Proses terputus karena restart ditandai gagal dan tidak dicoba ulang otomatis untuk menghindari request berbayar ganda.
- Generate master yang disebut oleh `@CHAR_*`, `@LOC_*`, `@PROP_*` sebelum generate shot. Gambar master terkait disertakan sebagai referensi; Omni memakai image shot sebagai start frame.

Pilihan `lighting` proyek: `auto` (default API/proyek lama), `drama`, `outdoor`, `horror`, `fantasy`, `anime`. Diterima pada POST `/api/drado/sessions` dan PATCH `/api/drado/sessions/:id`; perubahan ditolak selama script/media berjalan. Aturan preset ditambahkan pada setiap request script, termasuk followup/retry, dengan blok image `NATURAL FACIAL LIGHTING` dan video `FACIAL LIGHT CONTINUITY`. Hermes memuat skill lighting yang tersedia melalui `--skills`; Gemini memasukkan isi skill pendukung yang sama sebagai instruksi. `GET /api/drado/skills?lighting=drama` melaporkan preloads untuk pilihan proyek. Tes integrasi fitur: `bun run test:lighting` (runner Hermes dan endpoint Gemini berupa fixture lokal, tanpa panggilan generasi berbayar).

Preset `fantasy` dan `anime` mengatur gaya karakter/master serta image/video, bukan pencahayaan saja. `visualStyleInstructions` memasukkan override gaya ke instruksi sistem Gemini dan `HERMES_EPHEMERAL_SYSTEM_PROMPT` per subprocess Hermes tanpa mengubah konfigurasi global. Kedua preset tidak memuat skill lighting fotorealistik; netral pada character sheet berarti pencahayaan presentasi, bukan desain live-action. Prompt membawa `VISUAL STYLE LOCK` dan `STYLE CONTINUITY LOCK`; master lama tetap utuh dan varian ilustrasi baru memerlukan referensi yang sesuai sebelum I2V.

Pilihan **Storyboard** pada casting UI menyimpan `workflow: storyboard` per sesi. Jumlah episode dipilih di UI (1–100), lalu judul memakai langsung otomatis (80 detik per episode (8 shot × 10 detik)); Hermes menyusun arc, cliffhanger, opening bridge dan continuity antar-episode; backend memuat `drado-agent/references/storyboard-t2v-workflow.md` ke Hermes dan menyertakan aturan storyboard pada setiap pesan/retry. Gemini script menggunakan referensi yang sama. Master tetap DESIGNED sampai ada bukti approval. Jalankan `bun run test:storyboard` untuk verifikasi mode, persistence, retry, serta pemuatan referensi.

Image baru memakai **HD · 1K**: Gemini menerima `imageSize: 1K`; bridge Hermes meminta output sisi terpanjang 1024 piksel sesuai rasio. Request lama Auto/2K dinormalisasi ke 1K. Sesi Storyboard menyimpan `storyboardEpisodes` (1–100, default 1 untuk kompatibilitas); setiap prompt menyertakan jumlah episode dan aturan bridging/cliffhanger/continuity antar-episode.

Mode Storyboard mengunci tiap clip tepat **10 detik / 5 panel × 2 detik**, dengan peta beat konflik, dialog terjadwal, reaksi dan continuity handoff yang sama pada storyboard dan Omni. Shot pertama setiap episode wajib **ESTABLISHING** aktif (wide/medium-wide) dengan konflik sejak awal dan dialog dimulai maksimal detik pertama. Hermes memeriksa rencana teks sebelum menjawab; ini bukan validasi hasil visual.
