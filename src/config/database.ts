// Import Library
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@prisma/client";
// Import Config
import { readPositiveIntegerEnv, readRequiredEnv } from "./env";

/* -------------------------------------- Config -------------------------------------- */

// Config Prisma client ตัวเดียวของ process (สร้างแบบ lazy)
let prismaClient: PrismaClient | null = null;

/* -------------------------------------- Functions -------------------------------------- */

// Function อ่าน CA cert ของ DB จาก DATABASE_CA_CERT (รองรับค่าบรรทัดเดียวที่ใช้ \n)
function getDatabaseCaCert(): string | undefined {
  return process.env.DATABASE_CA_CERT?.trim().replace(/\\n/g, "\n") || undefined;
}

// Function ตัดพารามิเตอร์ ssl* ออกจาก URL เพราะ pg เอาค่าจาก URL ทับ ssl ที่ส่งเข้าไป
function stripSslParams(connectionString: string): string {
  const url = new URL(connectionString);

  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("ssl") || key === "uselibpqcompat") {
      url.searchParams.delete(key);
    }
  }

  return url.toString();
}

// Function สร้าง Prisma client พร้อม adapter ของ PostgreSQL
function createPrismaClient(): PrismaClient {
  const connectionString = readRequiredEnv("DATABASE_URL");
  const caCert = getDatabaseCaCert();
  const adapter = new PrismaPg({
    connectionString: caCert ? stripSslParams(connectionString) : connectionString,
    ssl: caCert ? { ca: caCert, rejectUnauthorized: true } : undefined,
    max: readPositiveIntegerEnv("DATABASE_POOL_MAX", 5),
  });

  return new PrismaClient({ adapter, log: ["error", "warn"] });
}

// Function คืน Prisma client ตัวเดียวของ process
export function getPrisma(): PrismaClient {
  prismaClient ??= createPrismaClient();
  return prismaClient;
}

// Function proxy ให้ import prisma ได้ทันที แต่สร้าง client จริงตอนใช้งานครั้งแรก
export const prisma = new Proxy({} as PrismaClient, {
  get(target, property, receiver) {
    return Reflect.get(getPrisma(), property, receiver ?? target);
  },
});

// Type client ที่ repository รับได้ (client หลัก หรือ client ใน transaction)
export type DbClient = PrismaClient | Prisma.TransactionClient;

// Function รันงานใน transaction เดียว (เรียกผ่าน client จริง ไม่ผ่าน proxy)
export function withTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return getPrisma().$transaction(work);
}

// Function ปิด Prisma client ตอน shutdown
export async function closePrisma(): Promise<void> {
  if (!prismaClient) {
    return;
  }

  await prismaClient.$disconnect();
  prismaClient = null;
}
