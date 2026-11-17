# Center Hook Backend

ตัวกลางของ LINE OA ที่ใช้ร่วมกันหลาย project ทั้งขาไป (project ส่งข้อความหา LINE) และขากลับ (LINE ส่ง event กลับมา) แต่ละ project ระบุตัวเองด้วย `smm_app` และ center-hook บันทึก log ทั้งสองทาง

**ขาไป**

```
project ──POST /api/line/push { smm_app, to, messages, retry_key }──► center-hook
   1. ตรวจ Authorization: Bearer <token> ตรงกับ LINE_CHANNEL_ACCESS_TOKEN (ไม่ผ่าน → 401)
      และ smm_app ต้องมีในตาราง webhooks (ไม่มี → 400 UNKNOWN_SMM_APP)
   2. ตัด smm_app / retry_key ออก แล้วส่ง { to, messages } ไป LINE ด้วย LINE_CHANNEL_ACCESS_TOKEN
      (retry_key → header X-Line-Retry-Key)
   3. บันทึก forward_logs (direction = OUTBOUND)
   4. ตอบ status และ body ของ LINE กลับตามจริง (project เป็นคน retry)
```

**ขากลับ**

```
LINE OA ──POST /api/line/webhook──► center-hook
   1. ตรวจ x-line-signature ด้วย LINE_CHANNEL_SECRET (ไม่ผ่าน → 401)
   2. ตอบ 200 ให้ LINE ทันที แล้วส่งต่อเบื้องหลัง
   3. แยกทีละ event → เลือกปลายทางจาก smm_app ใน postback data (ตาราง webhooks)
        ├─ smm_app ตรงกับ webhook       → webhook_url ของแถวนั้น
        └─ ไม่มี smm_app / ไม่รู้จัก     → webhook_url ของ webhook default (smm_app = null)
                                            ไม่มี default → บันทึก SKIPPED
   4. ส่ง { destination, events: [event] } พร้อมเซ็น x-line-signature ใหม่ด้วย secret เดิม
   5. บันทึก forward_logs (direction = INBOUND, SUCCESS / FAILED / SKIPPED)

   ข้อความที่พิมพ์ว่า "id" → center-hook ตอบ "Your user ID: <userId>" ผ่าน Reply API ก่อน
   (บันทึก OUTBOUND, project = center-hook) แล้วยังส่งต่อไป webhook default ตามข้อ 3-5
```

ปลายทางจะได้ request หน้าตาเหมือนที่ LINE ส่งมา และตรวจ signature ด้วย channel secret เดิมได้ ไม่ต้องแก้โค้ดฝั่งปลายทาง

## Project Structure

โครงสร้างแบบแบ่งตามชั้น (layered) ตามแบบ Node.js ทั่วไป: route → middleware → service → repository

```
index.ts                     เริ่ม server, ลบ log หมดอายุทุก 6 ชั่วโมง, graceful shutdown
src/
├─ app.ts                    ประกอบ middleware และ route ทั้งหมด
├─ config/
│  ├─ env.ts                 อ่าน/ตรวจค่า env
│  ├─ app.config.ts          ค่าคงที่ (forward, retention, LINE API)
│  ├─ auth.config.ts         อายุ token + อ่าน/ตรวจความแข็งแรงของ JWT secret
│  ├─ permission.config.ts   รายการสิทธิ์, dependency ของสิทธิ์, ลำดับ role (owner > manager > admin)
│  └─ database.ts            Prisma client + withTransaction
├─ routes/
│  ├─ auth.routes.ts         POST /api/auth/login, /refresh, /logout, GET /me, PATCH /me/password
│  ├─ admin.routes.ts        GET/POST /api/admins, GET/PATCH/DELETE /api/admins/:id, PATCH /api/admins/:id/password, POST /api/admins/:id/unlock
│  ├─ line.routes.ts         POST /api/line/webhook (ขากลับ), POST /api/line/push (ขาไป)
│  ├─ log.routes.ts          GET /api/forward-logs, /api/forward-logs/:id, /api/forward-logs/conversations
│  ├─ webhook.routes.ts      GET/POST /api/webhooks, PATCH/DELETE /api/webhooks/:smm_app
│  └─ health.routes.ts       GET /
├─ middlewares/              auth (Bearer LINE token ของ project + JWT/สิทธิ์ของผู้ดูแล), body, error, rate-limit, request-logger
├─ services/                 แบ่งตาม route
│  ├─ auth.service.ts        login / refresh (หมุน refresh token) / logout / me / เปลี่ยนรหัสตัวเอง
│  ├─ admin.service.ts       จัดการบัญชีผู้ดูแล + กฎ role และสิทธิ์
│  ├─ line/                  ของ line.routes.ts
│  │  ├─ inbound.service.ts  ขากลับ: เซ็น/ตรวจ signature, แยกทีละ event, ส่งต่อเบื้องหลัง, บันทึก log
│  │  ├─ forward.service.ts  ส่ง HTTP ไปปลายทาง + retry
│  │  └─ push.service.ts     ขาไป: push ผ่าน LINE Messaging API + บันทึก log
│  ├─ webhook.service.ts     ของ webhook.routes.ts: CRUD + เลือกปลายทางจาก smm_app + ตรวจ API key (cache 30 วินาที)
│  ├─ log.service.ts         ของ log.routes.ts: ค้นหา + ลบ log หมดอายุ
│  └─ health.service.ts      ของ health.routes.ts: ตรวจ process + database
├─ repositories/
│  ├─ account.repository.ts  accounts + account_permissions (Prisma)
│  ├─ session.repository.ts  user_sessions (Prisma)
│  ├─ log.repository.ts      forward_logs (Prisma)
│  └─ webhook.repository.ts  webhooks (Prisma)
├─ validations/              auth.schema.ts, admin.schema.ts, log.schema.ts, push.schema.ts, webhook.schema.ts (zod)
├─ types/                    แบ่งตาม route: auth.types.ts, line.types.ts, log.types.ts, webhook.types.ts, health.types.ts
│                            + app.types.ts (type ของ Hono context ที่ทั้ง app ใช้ร่วม)
├─ utils/                    api-helper (ApiError, router, sendJson, parseWithSchema), jwt, password (argon2), refresh-token-hash, logger, text, background-tasks
└─ docs/                     swagger.ts + openapi/*.yaml
```

## Tech Stack

| Technology | Version | Role |
| --- | --- | --- |
| [Bun](https://bun.sh) | 1.4.4 | runtime และ package manager |
| [TypeScript](https://www.typescriptlang.org) | 7.0.2 | ภาษา |
| [Hono](https://hono.dev) | 4.13.18 | web framework |
| PostgreSQL | 16 | database |
| [Prisma](https://www.prisma.io) | 7.10.1 | ORM และ migration |
| Docker | `oven/bun:1.4.4-alpine` | container สำหรับ deploy |

## Libraries

| Library | Version | Purpose |
| --- | --- | --- |
| `@hono/node-server` | 2.1.8 | รัน Hono เป็น HTTP server (อ่าน IP จาก socket ได้) |
| `@prisma/client`, `@prisma/adapter-pg` | 7.10.1 | Prisma client ต่อ PostgreSQL ผ่าน driver `pg` |
| `zod` | 4.6.7 | validate body, query และ path param |
| `hono-rate-limiter` | 0.5.4 | rate limit ต่อ IP แยกตามกลุ่ม route |
| `yaml` | 2.9.1 | อ่าน OpenAPI YAML มารวมเป็น spec |
| `swagger-ui-dist` | 5.35.0 | เสิร์ฟ Swagger UI ที่ `/api-docs` |
| `pino` | 10.4.0 | log แบบ JSON |
| `dotenv` | 18.0.10 | โหลด `.env` |
| `argon2` | 0.45.2 | hash รหัสผ่านด้วย argon2id (ค่าตาม OWASP) |
| `jsonwebtoken` | 9.0.3 | เซ็น/ตรวจ access token และ refresh token (HS256) |
| `p-queue` | 10.0.0 | จำกัดจำนวน argon2 verify ที่รันพร้อมกัน กัน CPU ตันตอนโดนยิง login |
| `tsx` (dev) | 4.23.15 | ให้ `node --test` รันไฟล์ TypeScript ได้ (ต้องมี Node.js 22+) |

Version คือเวอร์ชันที่ล็อกไว้ใน `bun.lock` (ใน `package.json` เป็นช่วง `^`) Middleware ในตัวของ Hono ที่ใช้: `secure-headers`, `cors`, `body-limit`, `request-id`

## Webhooks (`smm_app`)

ปลายทางของแต่ละ project เก็บในตาราง `webhooks` ของ DB (ไม่ใช้ env) จัดการผ่าน `/api/webhooks` (ต้อง login และมีสิทธิ์ `webhooks:*` ดูหัวข้อ "ผู้ดูแลและสิทธิ์")

| คอลัมน์ | ความหมาย |
| --- | --- |
| `smm_app` | ค่าที่ project แนบในปุ่มและใน body ของ `/api/line/push` (`null` = webhook default มีได้แถวเดียว) |
| `webhook_url` | ปลายทางที่ center-hook ส่ง event ต่อให้ (ขากลับ) |

migration สร้างตารางว่าง DB ใหม่ต้องเพิ่ม webhook เองผ่าน `POST /api/webhooks` (ถ้ายังไม่มี event ทุกตัวจะถูกบันทึกเป็น `SKIPPED`) เช่น

```http
POST /api/webhooks
{ "smm_app": "newlabor", "webhook_url": "https://labor-api-wadtr.ondigitalocean.app/api/line/webhook" }

POST /api/webhooks
{ "smm_app": null, "webhook_url": "https://test-hook-backend.onrender.com/webhook" }
```

`smm_app` อยู่คนละตำแหน่งในแต่ละขา

| ขา | ตำแหน่ง | ตัวอย่าง |
| --- | --- | --- |
| ไป | field บนสุดของ body `/api/line/push` | `"smm_app": "newlabor"` |
| กลับ | ใน postback data ของปุ่มที่ project ส่งออกไป | `"data": "smm_app=newlabor&token=...&score=5"` |

- ขากลับอ่านเฉพาะ event ชนิด `postback` เพราะเป็นข้อมูลเดียวที่ project กำหนดเองแล้ว LINE ส่งกลับมา ข้อความที่ผู้ใช้พิมพ์, sticker, follow และ event อื่นไป webhook default ทั้งหมด
- postback data ต้องเป็นรูปแบบ query string (`smm_app=newlabor&...`) ถ้าเป็น JSON จะอ่าน `smm_app` ไม่เจอและไป webhook default
- คอลัมน์ `project` ของ forward log เก็บค่า `smm_app` ที่ตรง หรือ `default` (ขาไปเก็บ `smm_app` ของ push หรือ `center-hook` สำหรับการตอบข้อความ "id")

ขากลับเลือกปลายทางตามนี้ (เทียบแบบตรงตัวทุกตัวอักษร `NewLabor` ≠ `newlabor`)

| postback data ของ event | ไปที่ |
| --- | --- |
| `smm_app=newlabor` (ตรงกับแถวในตาราง) | `webhook_url` ของแถวนั้น |
| ไม่ใช่ postback / ไม่มี `smm_app` / `smm_app=` / `smm_app=null` / ค่าที่ไม่ได้ลงทะเบียน | webhook default (ไม่มี default → `SKIPPED`) |
- รายการ webhook ถูก cache 30 วินาที แก้ผ่าน API แล้วมีผลทันที (ถ้าแก้ใน DB ตรงๆ รอไม่เกิน 30 วินาที)

### จัดการ webhook: `/api/webhooks`

| Method | Path | ใช้ทำ |
| --- | --- | --- |
| GET | `/api/webhooks` | ดูรายการ |
| POST | `/api/webhooks` | เพิ่ม `{ smm_app, webhook_url }` |
| PATCH | `/api/webhooks/:smm_app` | แก้บาง field (webhook default ใช้ `/api/webhooks/default`) |
| DELETE | `/api/webhooks/:smm_app` | ลบ (webhook default ใช้ `/api/webhooks/default`) |

ตอนสร้างต้องส่ง `smm_app` ทุกครั้ง ส่ง `"smm_app": null` = webhook default (ส่ง `""` หรือไม่ส่ง field ตอบ 400) ห้ามตั้งเป็น `"default"` เพราะเป็น path ของ webhook default มี default ได้แถวเดียว ถ้าจะเปลี่ยน URL ของ default ให้ `PATCH /api/webhooks/default { "webhook_url": "..." }` (POST ซ้ำตอบ 409 `DEFAULT_WEBHOOK_EXISTS`)

เพิ่ม project ใหม่: `POST /api/webhooks` แล้วให้ project นั้นส่ง `smm_app` ค่าเดียวกันใน body ของ `/api/line/push` และแนบ `smm_app=<ค่าเดียวกัน>` ในทุกปุ่ม (project ใช้ `LINE_CHANNEL_ACCESS_TOKEN` ตัวเดียวกับ center-hook เป็น Bearer ไม่มี key แยก)

### ขาไป: `POST /api/line/push`

```http
POST /api/line/push
Authorization: Bearer <LINE_CHANNEL_ACCESS_TOKEN>
Content-Type: application/json

{
  "smm_app": "newlabor",
  "to": "U4af4980629a1b2c3d4e5f60718293a4b",
  "retry_key": "3f6c2a8e-91d4-4b7a-a0e5-6d2c8f1b9e47",
  "messages": [{ "type": "flex", "altText": "แจ้งยกเลิกงาน 62411170000158 GV3/98", "contents": { "type": "bubble" } }]
}
```

- ส่งไป LINE ครั้งเดียวไม่ retry เอง และตอบ status กับ body ของ LINE กลับตามจริง เช่น `200 { sentMessages }`, `409` (retry_key นี้ส่งแล้ว), `429` (rate limit หรือโควต้ารายเดือนหมด) project เป็นคนตัดสินใจ retry ด้วย `retry_key` เดิม
- LINE ไม่ตอบภายใน 10 วินาที หรือเรียกไม่ได้ ตอบ `502 LINE_API_UNAVAILABLE` (ปรับเวลาได้ด้วย env `LINE_API_TIMEOUT_MS` ถ้าจำเป็น ต้องน้อยกว่า timeout ฝั่ง project)
- ไม่ได้ตั้ง `LINE_CHANNEL_ACCESS_TOKEN` ตอบ `503 LINE_PUSH_NOT_CONFIGURED`

## Forwarding (ขากลับ)

- timeout ต่อครั้ง `FORWARD_TIMEOUT_MS` (10 วินาที)
- retry สูงสุด `FORWARD_MAX_ATTEMPTS` ครั้ง (3) เฉพาะ 5xx, 429, timeout และ network error โดยรอ `FORWARD_RETRY_DELAY_MS × attempt`
- 4xx ไม่ retry
- ไม่มี webhook ปลายทาง (ไม่มี webhook default) → log เป็น `SKIPPED`
- ส่ง event ใน request เดียวกันตามลำดับ
- log เก่ากว่า `FORWARD_LOG_RETENTION_DAYS` (90 วัน) จะถูกลบอัตโนมัติทุก 6 ชั่วโมง

### Swagger

เปิด `/api-docs` (spec JSON ที่ `/api-docs/openapi.json`) สเปกเขียนเป็น YAML แยกไฟล์ตามกลุ่ม route ไว้ที่ [src/docs/openapi/](src/docs/openapi/) แล้ว [src/docs/swagger.ts](src/docs/swagger.ts) อ่านทุกไฟล์ใน `OPENAPI_FILES` มารวม `paths` และ `components` เป็น spec เดียวตอนเริ่ม server (ชื่อ path หรือ component ซ้ำข้ามไฟล์จะ error ทันที) เพิ่มไฟล์ใหม่ต้องใส่ชื่อลงใน `OPENAPI_FILES` ด้วย Swagger UI เสิร์ฟจาก `swagger-ui-dist` ในเครื่อง ไม่ใช้ CDN

- ตั้ง `API_DOCS_USERNAME` / `API_DOCS_PASSWORD` = ต้องใส่ Basic auth (ผิดตอบ 401 `API_DOCS_AUTH_REQUIRED`) แบบเดียวกับ Labor-Project-Backend
- ไม่ตั้งใน production (`NODE_ENV=production`) = ปิด docs (404) / ไม่ตั้งตอน dev = เปิดโล่ง
- รหัสนี้ใช้เปิดหน้า docs เท่านั้น ไม่เกี่ยวกับบัญชีผู้ดูแล
- ยิง API ที่ต้อง login จาก Swagger: `POST /api/auth/login` แล้วเอา `access_token` ใส่ปุ่ม **Authorize** (bearerAuth)

### Postman

Import [Postman_Collection.json](Postman_Collection.json) ตั้ง `baseUrl` ให้ตรงกับ server ตัวแปร collection ใช้ชื่อเดียวกับ `.env` ใส่ค่าเดียวกันได้เลย

| ตัวแปร | ใช้กับ |
| --- | --- |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | username/password ที่ใช้ login (ค่าเริ่มต้นเป็นบัญชีทดสอบ `owner`) request **Auth > Login** เก็บ `accessToken` / `refreshToken` ให้ทุก request ที่ต้อง login อัตโนมัติ |
| `LINE_CHANNEL_SECRET` | ขากลับ: เซ็น `x-line-signature` ของ `POST /api/line/webhook` (event จะถูกส่งต่อไปปลายทางจริง) |
| `LINE_CHANNEL_ACCESS_TOKEN` | ขาไป: `Authorization: Bearer` ของ `POST /api/line/push` (ข้อความจะถูกส่งหาผู้ใช้จริง) |

### Monitoring

- **ประวัติแชต (ทั้งข้อความผู้ใช้และ bot):** ใช้ [LINE Official Account Manager](https://manager.line.biz) > แชต ระบบนี้ไม่เก็บหรือแสดงแชตซ้ำ เปิด Chat คู่กับ Webhook ได้ใน Response settings (ควรปิดข้อความตอบกลับอัตโนมัติไม่ให้ซ้อนกับ bot)
- **ขาไปและขากลับของแต่ละ project:** `GET /api/forward-logs` และ `GET /api/forward-logs/{id}` filter `direction=OUTBOUND` (ข้อความที่ project ส่ง) หรือ `direction=INBOUND` (event ที่ส่งต่อให้ project) ร่วมกับ `project=newlabor` ซึ่ง OA Manager ไม่มีข้อมูลส่วนนี้

- **แบบแชท:** `GET /api/forward-logs/conversations` (log จัดกลุ่มตาม LINE user พร้อมชื่อ/รูปโปรไฟล์ ค้นหาด้วยชื่อหรือ user id กรอง project ได้) และ `GET /api/forward-logs/conversations/{line_user_id}` (ข้อความทั้งขาเข้าขาออกของคนนั้น โหลดย้อนหลังด้วย `before_id`) ชื่อ/รูปดึงจาก LINE API ด้วย `LINE_CHANNEL_ACCESS_TOKEN` แล้ว cache ในตาราง `line_profiles` (`LINE_PROFILE_CACHE_HOURS` ค่าเริ่มต้น 24)

`/api/forward-logs` ต้อง login และมีสิทธิ์ `forward_logs:read`

## ผู้ดูแลและสิทธิ์ (Login + Permission)

แทน Basic auth เดิม อิงรูปแบบจาก Labor-Project-Backend: login ด้วย username/password ได้ JWT, เก็บ session ใน DB และตรวจสิทธิ์รายบัญชีจากตาราง `account_permissions`

**Token และ session**

- `POST /api/auth/login` ได้ `access_token` (อายุ 15 นาที) + `refresh_token` (session อายุ 24 ชั่วโมงนับจาก login) ส่ง `Authorization: Bearer <access_token>`
- access token ใกล้หมดอายุ (เหลือไม่เกิน 2 นาที) response มี header `X-Should-Refresh: true` ให้ client เรียก `POST /api/auth/refresh` เอง
- refresh token ใช้ได้ครั้งเดียว (refresh แล้วได้ชุดใหม่ เก็บเฉพาะ HMAC ของ token ใน DB)
- หนึ่งบัญชีมี session เดียว login ที่ใหม่ = session เก่าใช้ไม่ได้ทันที
- ทุก request ตรวจ session และสถานะบัญชีใน DB logout / ปิดบัญชี / ลบบัญชี / แก้ role หรือสิทธิ์ / reset รหัส จึงมีผลทันทีไม่ต้องรอ token หมดอายุ
- รหัสผ่าน hash ด้วย argon2id, login ผิดตอบ `401 INVALID_CREDENTIALS` เหมือนกันทุกกรณี (ไม่บอกว่า username มีจริงไหม) และป้องกันการเดารหัส 2 ชั้น
  - ต่อ IP: `LOGIN_RATE_LIMIT_MAX_REQUESTS` (10) ครั้งต่อนาที นับทุกครั้งไม่แยก username เกินตอบ `429 RATE_LIMITED`
  - ต่อบัญชี: ใส่รหัสผิดติดกันครบ `LOGIN_MAX_FAILED_ATTEMPTS` (5) ครั้ง ล็อก `LOGIN_LOCK_MINUTES` (15) นาที ไม่ว่ามาจาก IP ไหน ตอบ `423 ACCOUNT_LOCKED` พร้อม `locked_until` / `retry_after_seconds` ระหว่างล็อกรหัสถูกก็เข้าไม่ได้ login สำเร็จรีเซ็ตตัวนับ ผู้ดูแลที่ role สูงกว่าปลดล็อกด้วย `POST /api/admins/:id/unlock` หรือตั้งรหัสใหม่ให้

**Role** (สูง → ต่ำ): `owner` > `manager` > `admin`

**สิทธิ์** เก็บรายบัญชีในตาราง `account_permissions` (รายการที่ระบบรู้จักอยู่ใน [permission.config.ts](src/config/permission.config.ts))

| สิทธิ์ | ใช้กับ |
| --- | --- |
| `forward_logs:read` | `GET /api/forward-logs`, `GET /api/forward-logs/:id`, `GET /api/forward-logs/conversations[/:line_user_id]` |
| `webhooks:read` / `create` / `update` / `delete` | `GET` / `POST` / `PATCH` / `DELETE` `/api/webhooks` |
| `admins:read` | `GET /api/admins`, `GET /api/admins/:id` |
| `admins:create` / `update` / `delete` | `POST` / `PATCH` / `DELETE` `/api/admins` |
| `admins:reset_password` | `PATCH /api/admins/:id/password` |

`create` / `update` / `delete` / `reset_password` ต้องมี `:read` ของกลุ่มเดียวกันด้วย (ไม่ครบตอบ `400 PERMISSION_DEPENDENCY_NOT_SATISFIED`) ไม่มีสิทธิ์ของ route ตอบ `403 FORBIDDEN` พร้อม `required_permissions`

**กฎการจัดการบัญชี** (`/api/admins`)

1. จัดการ (ดู, แก้, ลบ, ตั้งรหัสใหม่) ได้เฉพาะบัญชีที่ role **ต่ำกว่า** ตัวเอง role เท่ากันหรือสูงกว่าทำไม่ได้ (`403 TARGET_ROLE_NOT_MANAGEABLE`): owner → manager, admin | manager → admin | admin → ไม่มี
2. ตั้ง role ให้คนอื่น (ตอนสร้างหรือแก้) ได้เฉพาะ role ที่ต่ำกว่าตัวเอง (`403 ROLE_NOT_ASSIGNABLE`) จึงสร้าง owner ผ่าน API ไม่ได้ (ใช้ seed)
3. ให้สิทธิ์ได้เฉพาะที่ตัวเองมี (`403 PERMISSIONS_NOT_GRANTABLE` พร้อมรายการที่ให้ไม่ได้)
4. จัดการบัญชีตัวเองผ่าน `/api/admins` ไม่ได้ (`403 CANNOT_MANAGE_OWN_ACCOUNT`) ใช้ `GET /api/auth/me` และ `PATCH /api/auth/me/password`
5. ตอนสร้างต้องส่ง `permissions` เสมอ (ส่ง `[]` ได้) ตอนแก้ `permissions` = แทนที่ทั้งชุด

| Method | Path | สิทธิ์ | ใช้ทำ |
| --- | --- | --- | --- |
| GET | `/api/admins` | `admins:read` | รายการทุกบัญชี + `can_manage` |
| POST | `/api/admins` | `admins:create` | สร้าง `{ username, password, full_name, role, status?, permissions }` |
| GET | `/api/admins/:id` | `admins:read` | ดูบัญชีพร้อมสิทธิ์ |
| PATCH | `/api/admins/:id` | `admins:update` | แก้ `{ full_name?, role?, status?, permissions? }` (เปลี่ยน role/สถานะ/สิทธิ์ = revoke session ของบัญชีนั้น) |
| PATCH | `/api/admins/:id/password` | `admins:reset_password` | ตั้งรหัสใหม่ `{ new_password }` (revoke session + ปลดล็อก) |
| POST | `/api/admins/:id/unlock` | `admins:update` | ปลดล็อกบัญชีที่ใส่รหัสผิดจนถูกล็อก |
| DELETE | `/api/admins/:id` | `admins:delete` | ลบบัญชี |

**บัญชีทดสอบ** (`bun run db:seed` สร้างเฉพาะที่ยังไม่มี ไม่เขียนทับรหัสหรือสิทธิ์ที่แก้ไว้ / ใน production ต้องตั้ง `SEED_ALLOW_PRODUCTION=true` และควรเปลี่ยนรหัสทันที)

| role | username | password | สิทธิ์ |
| --- | --- | --- | --- |
| owner | `owner` | `Owner@123456` | ทุกสิทธิ์ |
| manager | `manager` | `Manager@123456` | ทุกสิทธิ์ (จัดการได้เฉพาะ admin) |
| admin | `admin` | `Admin@123456` | `forward_logs:read`, `webhooks:read` |

## Common Commands

ต้องมี [Bun 1.4.4](https://bun.sh) (Windows: `powershell -c "irm bun.sh/install.ps1 | iex"` อย่าติดตั้งผ่าน npm), Docker และ Node.js 22+ (สำหรับ test)

```bash
bun install
cp .env.example .env          # ใส่ JWT_* / REFRESH_TOKEN_HASH_SECRET (openssl rand -base64 32), LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN
bun run docker:db             # Postgres ที่ localhost:5435
bun run db:deploy             # หรือ bun run db:migrate ตอนแก้ schema
bun run db:seed               # บัญชีทดสอบ owner / manager / admin
bun run dev

bun run test                  # test ทุก route (node:test)
bun run typecheck
```
