# เริ่มใช้งาน — ทำบนเว็บ GitHub ทั้งหมด

ตั้งค่าครั้งเดียว 2 ขั้น ประมาณ 5 นาที

---

## ขั้นที่ 1 — อัปโหลดไฟล์เข้า IMCT_HUB

1. เปิด `github.com/IMCTConsumption/IMCT_HUB`
2. **Add file → Upload files**
3. ลากโฟลเดอร์ `source`, `config`, `tools` และไฟล์ `README.md`, `SETUP.md`, `.gitignore` ลงไป
4. Commit message: `Add build system`
5. **Commit changes**

> ⚠️ `index.html` เดิม (หน้า Hub) **อย่าลบ** — มันคือหน้าเว็บที่ deploy อยู่
>
> ⚠️ `README.md` จะทับของเดิม ถ้าอยากเก็บให้เปลี่ยนชื่อไฟล์เก่าก่อน

## ขั้นที่ 2 — สร้างไฟล์ workflow

โฟลเดอร์ที่ขึ้นต้นด้วยจุด (`.github`) บาง browser ลากไม่ได้ ให้สร้างเองแทน

1. ใน IMCT_HUB → **Add file → Create new file**
2. ช่องชื่อไฟล์ พิมพ์: `.github/workflows/build.yml`
   *(พิมพ์ `/` แล้วมันจะสร้างโฟลเดอร์ให้เอง)*
3. เปิดไฟล์ `.github/workflows/build.yml` ที่ผมส่งให้ คัดลอกทั้งหมด วางลงไป
4. **Commit changes**

**เสร็จแล้ว** — ไม่ต้องสร้าง Token ไม่ต้องตั้ง Secret

---

# ใช้งานประจำวัน

## แก้โค้ด

1. เปิดไฟล์ เช่น `source/core/10-core-head.js`
2. กดรูปดินสอ ✏️
3. แก้ → **Commit changes**

จะแก้อะไรอยู่ไฟล์ไหน:

| จะแก้ | ไฟล์ |
|---|---|
| หน้ากรอก, login, ตาราง, ตั้งค่า | `source/core/10-core-head.js` |
| กราฟ, header, เมนูข้าง | `source/core/90-core-tail.js` |
| รายงานรายเดือน (ไฟฟ้า) | `source/modules/summary-electric.js` |
| หน้าสรุป 2 ตาราง (น้ำ) | `source/modules/summary-water.js` |
| ค่าไฟ | `source/modules/cost.js` |
| หน้าตา สี ขนาด | `source/style.css` |
| โครง HTML | `source/shell-electric.html` / `shell-water.html` |
| backend | `source/backend/core.gs` |
| รายชื่อมิเตอร์เริ่มต้น | `source/backend/seeds/` |
| URL, ชื่อแอป, หน่วย | `config/<app>.json` |

## Build

1. แท็บ **Actions**
2. ซ้ายมือ **Build apps** → **Run workflow**
3. เลือกแอป (หรือ `all`) → **Run workflow** เขียว
4. รอ ~1 นาที จนขึ้น ✅

## เอาไฟล์ไปใช้

1. คลิกเข้าไปในงานที่รันเสร็จ
2. เลื่อนลงล่างสุด **Artifacts** → โหลด `imct-build` (เป็น zip)
3. แตกไฟล์ จะได้ `dist/<app>/index.html` และ `dist/<app>/Code.gs`

### index.html → repo ของแอป

1. เปิด repo นั้น เช่น `Electric-Meter-SR`
2. คลิก `index.html` → รูปดินสอ ✏️
3. **Ctrl+A** ลบทั้งหมด
4. เปิด `index.html` ที่โหลดมาด้วย Notepad → **Ctrl+A → Ctrl+C**
5. กลับมาที่ GitHub → **Ctrl+V** → **Commit changes**

> หรือใช้ **Add file → Upload files** ลากไฟล์ทับก็ได้ (ชื่อต้องเป็น `index.html`)

### Code.gs → Apps Script

1. เปิด Apps Script ของแอปนั้น
2. เปิด `Code.gs` ที่โหลดมา → **Ctrl+A → Ctrl+C**
3. ใน Apps Script → **Ctrl+A** ลบทั้งหมด → **Ctrl+V** → **Save**
4. **Deploy → Manage deployments → ✏️ → New version → Deploy**

> ⚠️ **อย่ากด "New deployment"** — จะได้ URL ใหม่ QR ที่พิมพ์แจกไปแล้วจะใช้ไม่ได้ทั้งหมด

---

## ลำดับที่ปลอดภัย

**ทีละแอป** — deploy Electric SR → ทดสอบ → ค่อยทำ Water SR

**ถ้า backend มี endpoint ใหม่** — paste `Code.gs` ก่อน แล้วค่อยเอา `index.html` ขึ้น

---

# เพิ่ม Gateway

## 1. สร้าง Google Sheet + Apps Script

1. สร้าง Google Sheet ใหม่ 2 ไฟล์ (ไฟฟ้า GW, น้ำ GW)
2. แต่ละไฟล์: **Extensions → Apps Script**
3. paste `Code.gs` จาก `dist/elec-gw/` และ `dist/water-gw/`
4. **แก้ 2 บรรทัดนี้ก่อน Save:**
   ```
   const ADMIN_SEED_PW    = 'CHANGE_ME_IN_APPS_SCRIPT';
   const RECORDER_SEED_PW = 'CHANGE_ME_IN_APPS_SCRIPT';
   ```
   ใส่รหัสจริง — **ตั้งให้ต่างจากแอปอื่น** และอย่าใช้รูปแบบเดิม (`sr@xxxAdmin2026`)
   ที่ Google เตือนว่าอยู่ในรายการรหัสที่รั่วไหล
5. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
6. คัดลอก URL ที่ได้ (ลงท้าย `/exec`)

## 2. ใส่ URL ลง config

1. ใน IMCT_HUB เปิด `config/elec-gw.json` → ✏️
2. แทนที่ `PASTE_GW_APPS_SCRIPT_EXEC_URL_HERE` ด้วย URL จริง
3. **Commit changes** → ทำแบบเดียวกันกับ `config/water-gw.json`

## 3. สร้าง repo ปลายทาง

1. `github.com/IMCTConsumption` → **New repository**
2. ชื่อ: `Electric-Meter-GW` → **Public** → **Create**
3. **Settings → Pages → Source: Deploy from a branch → main → / (root) → Save**
4. ทำแบบเดียวกันกับ `Water-Meter-GW`

## 4. Build แล้วเอาขึ้น

**Actions → Build apps → เลือก `elec-gw` → Run** แล้วเอา `index.html` ขึ้น repo ตามวิธีด้านบน

## 5. กรอกมิเตอร์

Gateway **ไม่มีรายชื่อมิเตอร์เริ่มต้น** — เปิดแอปครั้งแรกชีทจะถูกสร้างให้พร้อมหัวตาราง
จากนั้น login เป็น admin แล้วเพิ่มมิเตอร์ในหน้า **ตั้งค่า** หรือกรอกลงชีท `_METERS` ตรงๆ

> กรอกในชีทตรงๆ ต้องรัน `flushCaches()` ใน Apps Script หลังแก้เสร็จ
> ไม่งั้นต้องรอ cache หมดอายุ 12 ชั่วโมง

## 6. เพิ่มลิงก์ในหน้า Hub

เปิด `index.html` ใน IMCT_HUB → หา card ของ GW ที่ตอนนี้เป็น "Coming Soon"
→ เปลี่ยนเป็นลิงก์จริงเหมือน card ของ SR

---

## ถ้ามีปัญหา

| อาการ | ทำยังไง |
|---|---|
| Actions ขึ้น ❌ แดง | คลิกเข้าไปอ่าน log บรรทัดที่เป็นสีแดง |
| `ยังไม่ได้ตั้ง API_URL` | แก้ `config/<app>.json` ยังเป็น placeholder อยู่ |
| แก้ชีทแล้วเว็บไม่เปลี่ยน | รัน `flushCaches()` ใน Apps Script |
| หลัง deploy แล้วหน้าเว็บเหมือนเดิม | กด **Ctrl+Shift+R** (hard refresh) |
| Pages ยังไม่ขึ้น | รอ 1-2 นาที GitHub Pages ใช้เวลา deploy |
