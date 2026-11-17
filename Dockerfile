FROM oven/bun:1.4.4-alpine AS deps

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# prisma generate ต้องมี DATABASE_URL แต่ไม่ได้ต่อ DB จริง
ENV DATABASE_URL="postgresql://postgres:password@localhost:5432/center_hook"
COPY prisma.config.ts ./
COPY prisma ./prisma
RUN bun run db:generate

FROM oven/bun:1.4.4-alpine AS production

WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./
COPY --from=deps /app/prisma.config.ts ./
COPY --from=deps /app/prisma ./prisma
COPY tsconfig.json index.ts ./
COPY src ./src
# ที่เก็บฐานข้อมูล GeoLite2 ที่โหลดตอน start (user bun ต้องเขียนได้)
RUN mkdir -p /app/data && chown bun:bun /app/data

EXPOSE 8080
USER bun
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# migrate ก่อนแล้ว exec ให้ bun เป็น PID 1 รับ SIGTERM ตรงๆ
CMD ["sh", "-c", "bun run db:deploy && exec bun index.ts"]
