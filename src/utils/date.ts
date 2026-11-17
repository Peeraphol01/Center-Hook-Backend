/* -------------------------------------- Functions -------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

// Function หา offset (ms) ของ timezone ณ เวลาหนึ่ง เช่น Asia/Bangkok = +7 ชั่วโมง
function getTimezoneOffsetMs(instant: number, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, Number(part.value)])
  );
  const local = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);

  return local - Math.floor(instant / 1000) * 1000;
}

// Function วันที่ปัจจุบัน (YYYY-MM-DD) ตาม timezone
export function todayIn(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// Function บวก/ลบจำนวนวันของวันที่ YYYY-MM-DD
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

// Function เวลาเริ่มวัน (00:00) ของวันที่ YYYY-MM-DD ตาม timezone เป็น Date (UTC)
export function startOfDayIn(date: string, timezone: string): Date {
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);
  const offset = getTimezoneOffsetMs(utcMidnight, timezone);
  const start = utcMidnight - offset;
  // เผื่อ timezone ที่มีเวลาออมแสง (offset ตอนเริ่มวันต่างจากตอนเที่ยงคืน UTC)
  const actualOffset = getTimezoneOffsetMs(start, timezone);

  return new Date(actualOffset === offset ? start : utcMidnight - actualOffset);
}
