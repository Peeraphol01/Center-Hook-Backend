-- ตำแหน่งโดยประมาณของ IP ใน audit log (MaxMind GeoLite2): ประเทศ ISO 3166-1 alpha-2 และชื่อเมือง
ALTER TABLE "audit_logs" ADD COLUMN "geo_country" VARCHAR(2),
ADD COLUMN "geo_city" VARCHAR(100);
