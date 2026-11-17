// Import Library
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { Reader, type CityResponse } from "maxmind";
// Import Config
import { readOptionalEnv } from "../config/env";
// Import Utils
import { logger } from "../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

// Config ฐานข้อมูล MaxMind GeoLite2-City (แปลง IP เป็นประเทศ/เมือง ค้นในเครื่อง ไม่ส่ง IP ออกไปข้างนอก)
const GEOIP_CONFIG = {
  edition: "GeoLite2-City",
  downloadUrl: "https://download.maxmind.com/geoip/databases/GeoLite2-City/download?suffix=tar.gz",
  defaultPath: "data/GeoLite2-City.mmdb",
  // MaxMind อัปเดตสัปดาห์ละ 2 ครั้ง (อังคาร/ศุกร์) ไฟล์เก่ากว่านี้ = โหลดใหม่ (ฟรีโหลดได้ 30 ครั้งต่อวัน)
  maxAgeMs: 3 * 24 * 60 * 60 * 1000,
  checkIntervalMs: 12 * 60 * 60 * 1000,
  downloadTimeoutMs: 120_000,
};

// Config ตัวอ่านฐานข้อมูลที่โหลดแล้ว (null = ยังไม่มีไฟล์ / ไม่ได้ตั้ง MAXMIND_* → ไม่ระบุตำแหน่ง)
let reader: Reader<CityResponse> | null = null;
let updating: Promise<void> | null = null;

/* -------------------------------------- Types -------------------------------------- */

// Type ตำแหน่งโดยประมาณของ IP (null = หาไม่เจอ เช่น IP ภายใน / localhost)
export interface GeoLocation {
  // ISO 3166-1 alpha-2 เช่น TH
  country: string | null;
  city: string | null;
}

/* -------------------------------------- Helpers -------------------------------------- */

// Function อ่าน path ของไฟล์ .mmdb (MAXMIND_DB_PATH ไม่ตั้ง = data/GeoLite2-City.mmdb)
function getDbPath(): string {
  return resolve(readOptionalEnv("MAXMIND_DB_PATH") ?? GEOIP_CONFIG.defaultPath);
}

// Function อ่าน Account ID / License Key (ไม่ตั้งครบ = ไม่โหลดไฟล์เอง ใช้ไฟล์ที่มีอยู่ถ้ามี)
function getCredentials(): { accountId: string; licenseKey: string } | null {
  const accountId = readOptionalEnv("MAXMIND_ACCOUNT_ID");
  const licenseKey = readOptionalEnv("MAXMIND_LICENSE_KEY");

  return accountId && licenseKey ? { accountId, licenseKey } : null;
}

// Function อายุของไฟล์ (ms) ไม่มีไฟล์คืน null
async function getFileAgeMs(path: string): Promise<number | null> {
  const info = await stat(path).catch(() => null);

  return info ? Date.now() - info.mtimeMs : null;
}

// Function ดึงไฟล์ .mmdb ออกจาก tar (รูปแบบ tar: header 512 byte ตามด้วยข้อมูลที่ปัดเป็น 512)
function extractMmdb(tar: Buffer): Buffer {
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");

    if (!name) {
      break;
    }

    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    const start = offset + 512;

    if (name.endsWith(".mmdb")) {
      return tar.subarray(start, start + size);
    }

    offset = start + Math.ceil(size / 512) * 512;
  }

  throw new Error(`${GEOIP_CONFIG.edition}.mmdb not found in the downloaded archive.`);
}

// Function ดาวน์โหลดฐานข้อมูลจาก MaxMind แล้วเขียนทับไฟล์เดิมแบบ atomic
async function downloadDatabase(path: string, credentials: { accountId: string; licenseKey: string }): Promise<void> {
  const signal = AbortSignal.timeout(GEOIP_CONFIG.downloadTimeoutMs);
  const authorization = `Basic ${Buffer.from(`${credentials.accountId}:${credentials.licenseKey}`).toString("base64")}`;

  // MaxMind ตอบ redirect ไป storage ของไฟล์: ตามเองและไม่ส่ง Authorization ต่อไปที่ปลายทางนั้น
  let response = await fetch(GEOIP_CONFIG.downloadUrl, { headers: { authorization }, redirect: "manual", signal });
  const location = response.headers.get("location");

  if (response.status >= 300 && response.status < 400 && location) {
    response = await fetch(new URL(location, GEOIP_CONFIG.downloadUrl), { signal });
  }

  if (!response.ok) {
    const hint = response.status === 401 ? " Check MAXMIND_ACCOUNT_ID / MAXMIND_LICENSE_KEY." : "";
    throw new Error(`GeoLite2 download failed with HTTP ${response.status}.${hint}`);
  }

  const mmdb = extractMmdb(gunzipSync(Buffer.from(await response.arrayBuffer())));
  // ตรวจว่าเปิดได้จริงก่อนเขียนทับไฟล์เดิม
  new Reader<CityResponse>(mmdb);

  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, mmdb);
  await rename(tempPath, path);
}

// Function เปิดไฟล์ .mmdb เข้า memory (ไม่มีไฟล์ = ไม่ทำอะไร)
async function loadDatabase(path: string): Promise<void> {
  const data = await readFile(path).catch(() => null);

  if (data) {
    reader = new Reader<CityResponse>(data);
  }
}

// Function อัปเดตฐานข้อมูลถ้าไฟล์เก่าหรือยังไม่มี แล้วโหลดเข้า memory (error แค่เขียน log ระบบยังทำงานได้โดยไม่มีตำแหน่ง)
async function refreshDatabase(): Promise<void> {
  const path = getDbPath();
  const credentials = getCredentials();
  const age = await getFileAgeMs(path);

  if (credentials && (age === null || age > GEOIP_CONFIG.maxAgeMs)) {
    try {
      await downloadDatabase(path, credentials);
      logger.info("GeoLite2 database downloaded.", { path });
    } catch (error) {
      logger.warn("Failed to download GeoLite2 database. IP location will use the existing file if any.", { error });
    }
  }

  // โหลดครั้งแรก หรือไฟล์ถูกโหลดใหม่ (อายุน้อยกว่าตอนเช็ก) = เปิดไฟล์ใหม่
  const newAge = await getFileAgeMs(path);

  if (!reader || (newAge !== null && (age === null || newAge < age))) {
    try {
      await loadDatabase(path);
    } catch (error) {
      logger.warn("Failed to open GeoLite2 database. IP location is disabled.", { path, error });
    }
  }
}

/* -------------------------------------- Functions -------------------------------------- */

// Function เริ่มระบบระบุตำแหน่ง: โหลด/อัปเดตไฟล์ตอน start แล้วเช็กทุก 12 ชั่วโมง (ไม่บล็อกการเปิด server)
export function startGeoIp(): NodeJS.Timeout {
  const run = () => {
    updating ??= refreshDatabase().finally(() => {
      updating = null;
    });
  };

  if (!getCredentials()) {
    logger.info("MAXMIND_ACCOUNT_ID / MAXMIND_LICENSE_KEY not set. IP location uses the local file only if it exists.");
  }

  run();
  const timer = setInterval(run, GEOIP_CONFIG.checkIntervalMs);
  timer.unref();
  return timer;
}

// Function หาตำแหน่งโดยประมาณของ IP (ยังไม่มีฐานข้อมูล / IP ภายใน / ค่าผิดรูป = null ทั้งคู่)
export function lookupIp(ip: string | null): GeoLocation {
  if (!reader || !ip) {
    return { country: null, city: null };
  }

  try {
    const result = reader.get(ip);

    return {
      country: result?.country?.iso_code ?? result?.registered_country?.iso_code ?? null,
      city: result?.city?.names?.en ?? null,
    };
  } catch {
    return { country: null, city: null };
  }
}
