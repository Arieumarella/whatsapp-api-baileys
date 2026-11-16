# WhatsApp API — Baileys

API WhatsApp ringan untuk mengirim **pesan teks** dan **file (nota PDF, gambar, video, dokumen)**.
Dibangun dengan **Baileys** (koneksi WebSocket langsung), **tanpa Chromium / Puppeteer**.

Cocok dipakai sebagai service kecil di belakang aplikasi POS: hemat RAM, cepat start, dan
sesi WhatsApp tetap tersimpan setelah restart.

---

## Kenapa versi ini ringan?

| | Versi lama (whatsapp-web.js) | Versi ini (Baileys) |
|---|---|---|
| Mesin | Chromium headless | WebSocket langsung |
| RAM | ~500 MB+ | **~80–130 MB** |
| Proses | Banyak proses browser | 1 proses Node |
| Start | 15–30 detik | 3–5 detik |
| Disk image | Besar (Chromium) | Kecil (`node:20-alpine`) |

Penyebab aplikasi ngelag sebelumnya adalah Chromium. Di versi ini Chromium **tidak dipakai sama sekali**.

---

## Fitur

- Kirim pesan teks
- Kirim file: PDF, gambar, video, dokumen (multipart, base64, atau URL)
- QR code login (data URL atau ASCII di log)
- Sesi otomatis tersimpan (tidak perlu scan ulang setelah restart)
- Auto-reconnect saat koneksi terputus
- Endpoint **kompatibel** dengan versi lama, frontend tidak perlu diubah
- Resource limit bawaan (RAM 256 MB, CPU 0.25) agar tidak mengganggu service lain

---

## Endpoint

| Method | Path | Keterangan |
|--------|------|------------|
| GET | `/health` | Health check → `{ status, ready, uptime }` |
| GET | `/status` | Status koneksi → `{ ready, info }` |
| GET | `/qr` | QR login (data URL) saat belum terhubung |
| POST | `/send` | Kirim pesan teks |
| POST | `/send-file` | Kirim file (PDF/gambar/video/dokumen) |
| POST | `/logout` | Logout & hapus sesi |
| POST | `/client/restart` | Logout lalu inisialisasi ulang |

**Format nomor telepon** fleksibel, otomatis dinormalisasi ke `62...`:
`0895...`, `+62895...`, atau `62895...`.

---

## Prasyarat

- Docker + Docker Compose v2 (`docker compose version`)
- Network Docker bersama `pos_network` (dipakai juga oleh container API & frontend)

```bash
docker network create pos_network    # cukup sekali
```

---

## Quick Start (Docker)

```bash
# 1. Siapkan konfigurasi
cp .env.example .env

# 2. Build & jalankan
docker compose up -d --build

# 3. Cek status
curl -s http://localhost:5000/status
```

### Login WhatsApp (scan QR, cukup sekali)

Pilih salah satu:

```bash
# Cara A: lihat QR ASCII langsung di log
docker compose logs -f whatsapp-api

# Cara B: ambil data URL QR, lalu buka di browser dan scan
curl -s http://localhost:5000/qr
```

Setelah discan, status berubah menjadi `ready: true` dan sesi tersimpan otomatis
di volume `whatsapp_auth`. Restart container **tidak** perlu scan ulang.

---

## Contoh pemakaian

### Kirim pesan teks

```bash
curl -X POST http://localhost:5000/send \
  -H "Content-Type: application/json" \
  -d '{"number":"089530518554","message":"Halo dari API"}'
```

Respons:

```json
{ "ok": true, "id": "3EB0..." }
```

### Kirim PDF (multipart)

```bash
curl -X POST http://localhost:5000/send-file \
  -F "file=@nota.pdf" \
  -F "number=089530518554" \
  -F "caption=Nota pembelian Anda"
```

### Kirim file via URL

```bash
curl -X POST http://localhost:5000/send-file \
  -H "Content-Type: application/json" \
  -d '{"number":"6289530518554","fileUrl":"https://example.com/nota.pdf","caption":"Nota"}'
```

### Kirim file via base64

```bash
curl -X POST http://localhost:5000/send-file \
  -H "Content-Type: application/json" \
  -d '{"number":"6289530518554","fileBase64":"data:application/pdf;base64,JVBERi0...","caption":"Nota"}'
```

### Contoh dari JavaScript (fetch)

```js
const form = new FormData();
form.append('file', pdfBlob, 'nota.pdf');
form.append('number', '089530518554');
form.append('caption', 'Nota pembelian Anda');

const res = await fetch('http://localhost:5000/send-file', {
  method: 'POST',
  body: form,
});
const data = await res.json();  // { ok: true, id: "..." }
```

---

## Jalankan tanpa Docker (lokal)

```bash
npm install
cp .env.example .env
npm start          # http://localhost:5000
```

Sesi tersimpan di folder `./auth`.

---

## Perintah harian

```bash
docker compose ps                         # status container
docker compose logs -f whatsapp-api       # log (QR ASCII muncul di sini)
docker compose restart whatsapp-api       # restart service WA saja
docker compose down                        # stop (volume & sesi tetap aman)
docker compose up -d --build              # build ulang + start
```

---

## Update dari GitHub

```bash
cd /opt/whatsapp-api
git pull
docker compose up -d --build
```

---

## Struktur file

```
.
├── server.js            # implementasi API (Baileys + Express)
├── package.json         # dependensi
├── Dockerfile           # image ringan node:20-alpine
├── docker-compose.yml   # limit resource + volume auth
├── .env.example         # contoh konfigurasi
├── docs.html            # dokumentasi versi web
└── postman_collection.json
```

Sesi (jangan di-commit) dibuat otomatis di folder `auth/` / volume `whatsapp_auth`.

---

## Troubleshooting

| Masalah | Solusi |
|---------|--------|
| `ready: false` terus | Buka `/qr` lalu scan; cek log `docker compose logs -f whatsapp-api` |
| QR tidak muncul | Pastikan `/status` `ready:false`, lalu `curl -s http://localhost:5000/qr` |
| Nomor tidak valid | Gunakan minimal 8 digit; format `08...`, `+628...`, atau `628...` |
| `pos_network` error | `docker network create pos_network` |
| File ditolak | Hanya PDF, gambar, video, dokumen; maksimal 25 MB |

---

## Catatan keamanan

- Jaga folder `auth/` / volume `whatsapp_auth`. Siapa pun yang memilikinya bisa mengakses akun WhatsApp.
- Jangan commit `.env` dan `auth/` (sudah masuk `.gitignore`).
- Service ini sebaiknya tidak diekspos langsung ke internet; akses lewat reverse proxy + HTTPS.
