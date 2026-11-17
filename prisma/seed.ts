// Import Library
import "dotenv/config";
// Import Config
import { closePrisma, prisma } from "../src/config/database";
import { PERMISSIONS, type Permission, type Role } from "../src/config/permission.config";
// Import Utils
import { hashPassword } from "../src/utils/password";

/* -------------------------------------- Config -------------------------------------- */

// Config บัญชีทดสอบ role ละหนึ่งบัญชี (รหัสผ่านสำหรับทดสอบเท่านั้น เปลี่ยนทันทีถ้าใช้บน server จริง)
const SEED_ACCOUNTS: { role: Role; username: string; password: string; fullName: string; permissions: readonly Permission[] }[] = [
  {
    role: "owner",
    username: "owner",
    password: "Owner@123456",
    fullName: "Test Owner",
    permissions: PERMISSIONS,
  },
  {
    role: "manager",
    username: "manager",
    password: "Manager@123456",
    fullName: "Test Manager",
    permissions: PERMISSIONS,
  },
  {
    role: "admin",
    username: "admin",
    password: "Admin@123456",
    fullName: "Test Admin",
    permissions: ["forward_logs:read", "webhooks:read"],
  },
];

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้างบัญชีทดสอบที่ยังไม่มี (มีอยู่แล้วข้าม ไม่เขียนทับรหัสผ่านหรือสิทธิ์ที่แก้ไว้)
async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production" && process.env.SEED_ALLOW_PRODUCTION !== "true") {
    throw new Error("Refusing to seed test accounts in production. Set SEED_ALLOW_PRODUCTION=true to override.");
  }

  let ownerId: number | null = null;

  for (const seed of SEED_ACCOUNTS) {
    const existing = await prisma.account.findUnique({ where: { username: seed.username } });

    if (existing) {
      console.log(`skip   ${seed.role.padEnd(7)} ${seed.username} (already exists, id ${existing.id})`);
      ownerId ??= seed.role === "owner" ? existing.id : null;
      continue;
    }

    const account = await prisma.account.create({
      data: {
        username: seed.username,
        passwordHash: await hashPassword(seed.password),
        role: seed.role,
        status: "active",
        fullName: seed.fullName,
        createdBy: ownerId,
        permissions: { create: seed.permissions.map((permission) => ({ permission })) },
      },
    });

    ownerId ??= seed.role === "owner" ? account.id : null;
    console.log(`create ${seed.role.padEnd(7)} ${seed.username} / ${seed.password} (id ${account.id})`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closePrisma());
