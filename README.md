# StaccFlip

Bot Solana untuk berinteraksi dengan **stacflip.app** — game flip (50/50 betting) di atas bonding curve `GpNQyoZyi8unNu8dpYGHEqJXCHQy9B8mUFNgBs4sqDSQ`, menggunakan **Switchboard On-Demand Randomness** sebagai sumber acak.

Repo ini berisi koleksi script CLI: scanner pasar, auto-flip, hunter (auto-pilot), redeem hasil menang, dan utility lain.

> **Disclaimer**: project ini untuk eksperimen / riset. Pakai wallet kosong / dana kecil dulu. Anda menanggung sendiri semua risiko kehilangan dana.

---

## Arsitektur Singkat

```
                    +--------------------+
                    |  stacc-backend     |  <- REST API stacflip
                    |  (Vercel)          |     /auto-pick, /pools, dll
                    +---------+----------+
                              |
   +--------------+           v            +---------------------+
   |  scan.ts     |   +--------------+     |  Switchboard        |
   |  scan-thin   |-->|  hunter.ts   |---->|  On-Demand          |
   |  scan-vault  |   |  auto-flip   |     |  (randomness)       |
   +--------------+   |  flip-once   |     +---------------------+
                      +------+-------+
                             | commit -> reveal
                             v
                  +------------------------+
                  |  Flip Program (Solana) |
                  |  bonding-curve PDA     |
                  +----------+-------------+
                             | menang? -> token MEME
                             v
                      +--------------+
                      |  redeem.ts   | -- claim payout
                      |  sell.ts     | -- jual MEME -> LST
                      |  sell-jup    | -- jual via Jupiter -> SOL
                      +--------------+
```

**Quote token** semua transaksi adalah **stacSOL (LST)** — Liquid Staking Token Token-2022 dengan mint `6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f`. SOL otomatis di-stake via SPL stake pool menjadi LST sebelum dipakai bertaruh.

**Flow flip:**
1. **Commit** — kirim instruksi `flip` ke program, taruh wager (dalam LST), lock randomness account.
2. Tunggu ~33 slot (sekitar 15 detik) sampai Switchboard reveal value-nya.
3. **Reveal** — fetch signature dari Switchboard gateway, panggil `reveal_randomness`. Program menentukan menang/kalah berdasarkan hash.
4. **Redeem** — kalau menang, redeem token MEME hasil flip; bisa langsung dijual ke LST atau swap ke SOL via Jupiter.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Buat file `.env` di root

```env
# RPC mainnet — wajib pakai RPC premium (Helius/Triton/QuickNode)
# RPC publik tidak akan sanggup untuk hunter/auto-flip
RPC_URL=https://your-rpc-endpoint

# Private key wallet bot (base58, format Phantom export)
PRIVATE_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# === Konfigurasi hunter (opsional, ada default) ===
WAGER_SOL=0.01            # ukuran wager per flip (dalam SOL)
MIN_LEVERAGE_X=10         # minimum leverage payout untuk auto-fire
POLL_INTERVAL_MS=5000     # interval polling auto-pick (ms)
GAP_SLOTS=33              # gap commit->reveal
REVEAL_RETRIES=6          # retry reveal kalau gateway timeout
REVEAL_RETRY_DELAY=3000   # delay antar retry (ms)

# Switchboard oracle (opsional, ada pool default)
# SB_QUEUE=A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w
# SB_ORACLE_LIST=oracle1,oracle2,...
```

> **Format private key**: kalau export-mu berupa array `[1,2,3,...]`, pakai `tsx convert-key.ts` untuk konversi ke base58.

### 3. Sanity check

```bash
tsx check-sdk.ts          # cek versi & koneksi RPC
```

---

## Daftar Script

| npm script           | File                  | Fungsi |
| -------------------- | --------------------- | ------ |
| `npm run scan`       | `scan.ts`             | Scan **semua** bonding curve aktif di program flip, urutkan berdasarkan TVL / harga. Quick overview pasar. |
| `npm run scan-thin`  | `scan-thin-pools.ts`  | Cari pool dengan likuiditas tipis — kandidat leverage tinggi (payout besar relatif terhadap wager). |
| `npm run scan-vault` | `scan-vault.ts`       | Cek isi vault treasury program (akumulasi fee). |
| `npm run flip`       | `flip.ts`             | Flip **manual one-shot** menggunakan konstanta hard-coded (attacker vs target mint sudah ditentukan di file). Untuk testing struktur transaksi. |
| `npm run once`       | `flip-once.ts`        | Flip satu kali pakai **auto-pick** dari backend (pilih pair termurah × TVL tertinggi otomatis). Full cycle: commit -> reveal -> log hasil. |
| `npm run auto`       | `auto-flip.ts`        | Loop versi sederhana: tanya backend `/auto-pick`, flip, ulang. Tanpa filter leverage. |
| `npm run hunter`     | `hunter.ts`           | **Auto-pilot lengkap** — polling auto-pick, filter `MIN_LEVERAGE_X`, rotasi oracle pool, retry reveal, swallow timeout, address lookup table. Versi production. |
| `npm run hunter:dry` | `hunter.ts` (DRY_RUN) | Mode simulasi — print rencana flip tanpa kirim transaksi. Untuk debug konfigurasi. |
| `npm run redeem`     | `redeem.ts`           | Klaim token MEME hasil flip yang menang (jalankan `redeem` instruction). |
| `npm run sim-redeem` | `simulate-redeem.ts`  | Dry-run redeem — lihat berapa MEME yang akan didapat tanpa eksekusi on-chain. |
| `npm run sell`       | `sell.ts`             | Jual MEME hasil redeem -> kembali ke LST via bonding curve (sell instruction native). |
| `npm run sell-jup`   | `sell-jupiter.ts`     | Jual MEME -> SOL via **Jupiter aggregator** (kalau pool sell di curve thin / depeg). |
| `npm run close-vaa`  | `close-vaa.ts`        | Tutup akun randomness Switchboard yang sudah terpakai -> reclaim rent (~0.002 SOL/akun). |
| `npm run recover`    | `recover.ts`          | Rescue helper kalau ada flip stuck (commit tapi belum reveal & sudah lewat window). |
| `tsx convert-key.ts` | `convert-key.ts`      | Konversi private key dari array JSON `[1,2,...]` -> base58 string. |
| `tsx check-sdk.ts`   | `check-sdk.ts`        | Smoke test koneksi RPC + versi Switchboard SDK. |

---

## Alur Penggunaan yang Disarankan

### A. Discovery (read-only, tidak butuh PRIVATE_KEY)
```bash
npm run scan          # lihat semua pool
npm run scan-thin     # cari opportunity leverage tinggi
```

### B. Test manual sekali flip
```bash
npm run hunter:dry    # cek konfigurasi tanpa kirim tx
npm run once          # flip satu kali, lihat hasilnya
```

### C. Auto-pilot
```bash
npm run hunter        # biarkan jalan di background / tmux / screen
```
Hunter akan:
- Polling backend tiap `POLL_INTERVAL_MS`
- Skip kalau leverage < `MIN_LEVERAGE_X`
- Commit -> tunggu 33 slot -> reveal -> log W/L
- Rotasi 6 oracle pool kalau ada yang ETIMEDOUT
- Retry reveal sampai 6x sebelum menyerah

### D. Cash-out
```bash
npm run sim-redeem    # cek expected payout
npm run redeem        # klaim MEME
npm run sell          # jual via bonding curve (kalau likuid)
# atau:
npm run sell-jup      # jual via Jupiter (kalau curve thin / harga lebih bagus)
```

### E. Housekeeping
```bash
npm run close-vaa     # reclaim rent dari randomness account yang sudah selesai
```

---

## Konstanta Program (referensi)

| Item                       | Address |
| -------------------------- | ------- |
| Flip Program ID            | `GpNQyoZyi8unNu8dpYGHEqJXCHQy9B8mUFNgBs4sqDSQ` |
| Switchboard On-Demand      | `SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv` |
| Switchboard Queue          | `A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w` |
| Stacc Quote Mint (LST)     | `6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f` |
| Global PDA                 | `6L6tTZEsJMmQ896wzGL2MUbd3Bg3rdboMXxQDQwKzRFN` |
| Fee Recipient              | `WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb` |
| Event Authority            | `2m3237w5ModQZ2ZTt9BJo3dNJ2KM8XqWnP8csM8saw2P` |
| Shared LUT (frontend)      | `HEeCcQnd2JZP8Cu7Prs17JtEGgJj4YXcRddbV8a3us71` |
| SPL Stake Pool Program     | `SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY` |
| Backend API                | `https://stacc-backend.vercel.app` |

IDL Anchor program ada di [`idl.json`](./idl.json).

---

## Troubleshooting

| Gejala | Penyebab umum | Fix |
| ------ | ------------- | --- |
| `ETIMEDOUT` saat reveal | Oracle gateway IP-nya diblokir region kamu | Ganti `SB_ORACLE_LIST` di `.env` ke pool yang reachable |
| `BlockhashNotFound` | RPC lemot / saturated | Pakai RPC premium (Helius/Triton) |
| `Custom program error: 0x1771` | Wager > saldo LST wallet | Top-up SOL, atau turunkan `WAGER_SOL` |
| Reveal selalu fail | Slot gap < 33 | Naikkan `GAP_SLOTS` |
| Node 22 crash dengan UnhandledRejection | Switchboard SDK timer leak | Sudah di-swallow di `hunter.ts`, gunakan script ini |

---

## Lisensi

Pribadi / non-komersial. **Tidak ada garansi.** Gunakan dengan tanggung jawab sendiri.
