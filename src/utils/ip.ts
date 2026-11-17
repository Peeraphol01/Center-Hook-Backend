// Import Library
import { BlockList, isIP } from "node:net";

/* -------------------------------------- Types -------------------------------------- */

// Type ตัวตรวจว่า IP อยู่ในวงที่อนุญาต
export interface IpMatcher {
  matches(ip: string | null): boolean;
}

/* -------------------------------------- Functions -------------------------------------- */

// Function ทำ IP ให้อยู่รูปแบบเดียวกัน (ตัด zone id และ prefix ::ffff: ของ IPv4 ที่ map มาเป็น IPv6) ไม่ใช่ IP คืน null
export function normalizeIp(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/^\[|\]$/g, "").split("%")[0];

  if (!trimmed) {
    return null;
  }

  const unmapped = trimmed.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");

  return isIP(unmapped) ? unmapped.toLowerCase() : null;
}

// Function เลือก IP ของ client จาก X-Forwarded-For โดยเชื่อ proxy hops ชั้น (นับจากขวา) ค่าผิดรูปคืน null
export function pickForwardedIp(header: string | undefined, hops: number): string | null {
  if (!header || hops <= 0) {
    return null;
  }

  const addresses = header.split(",").map((item) => item.trim()).filter(Boolean);

  if (addresses.length === 0) {
    return null;
  }

  // proxy ชั้นนอกสุดต่อท้าย IP ที่เห็นจริง ค่าด้านซ้ายกว่านั้น client ใส่มาเองได้จึงไม่เชื่อ
  return normalizeIp(addresses[Math.max(addresses.length - hops, 0)]);
}

// Function แปลงรายการ IP/CIDR คั่นด้วย comma เป็นตัวตรวจ (ค่าผิดรูป throw พร้อมชื่อ env)
export function parseCidrList(raw: string, label: string): IpMatcher {
  const list = new BlockList();

  for (const entry of raw.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [address, prefixText] = entry.split("/");
    const ip = normalizeIp(address);
    const type = ip && isIP(ip) === 6 ? "ipv6" : "ipv4";
    const maxPrefix = type === "ipv6" ? 128 : 32;
    const prefix = prefixText === undefined ? maxPrefix : Number(prefixText);

    if (!ip || !Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
      throw new Error(`${label} contains an invalid IP or CIDR: "${entry}".`);
    }

    list.addSubnet(ip, prefix, type);
  }

  return {
    matches(value) {
      const ip = normalizeIp(value);
      return ip !== null && list.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");
    },
  };
}
