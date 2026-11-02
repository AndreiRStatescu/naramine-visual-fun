import fs from "node:fs";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import { config } from "@/server/config";

fs.mkdirSync(config.dataRoot, { recursive: true });
fs.mkdirSync(path.dirname(config.databaseFilePath), { recursive: true });

const globalForPrisma = globalThis as unknown as {
  ievcsPrisma?: PrismaClient;
  ievcsDatabaseReady?: Promise<void>;
};

export const db =
  globalForPrisma.ievcsPrisma ??
  new PrismaClient({
    datasources: { db: { url: config.databaseUrl } },
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.ievcsPrisma = db;
}

export function ensureDatabaseReady(): Promise<void> {
  globalForPrisma.ievcsDatabaseReady ??= (async () => {
    await db.$queryRawUnsafe("PRAGMA journal_mode = WAL");
    await db.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
    await db.$queryRawUnsafe("PRAGMA foreign_keys = ON");
  })();
  return globalForPrisma.ievcsDatabaseReady;
}

export default db;
