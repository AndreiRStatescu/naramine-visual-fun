import { mkdir, open } from "node:fs/promises";
import path from "node:path";

try {
  process.loadEnvFile();
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const workspace = process.cwd();
const configuredDataRoot =
  process.env.IEVCS_DATA_ROOT ?? process.env.IEVCS_DATA_DIR ?? "data";
const dataRoot = path.resolve(workspace, configuredDataRoot);
const databaseUrl =
  process.env.DATABASE_URL ?? `file:${path.join(dataRoot, "ievcs.db")}`;

if (!databaseUrl.startsWith("file:")) {
  throw new Error("IEVCS requires a SQLite DATABASE_URL beginning with file:");
}

const databasePathValue = databaseUrl.slice("file:".length).split("?", 1)[0];
if (!databasePathValue) {
  throw new Error("DATABASE_URL must name a SQLite database file");
}

// Prisma CLI resolves relative SQLite paths from prisma/schema.prisma.
const databasePath = path.isAbsolute(databasePathValue)
  ? databasePathValue
  : path.resolve(workspace, "prisma", databasePathValue);

await Promise.all([
  mkdir(dataRoot, { recursive: true }),
  mkdir(path.join(dataRoot, "projects"), { recursive: true }),
  mkdir(path.dirname(databasePath), { recursive: true }),
]);

// Some mounted local filesystems do not let Prisma's schema engine create the
// SQLite file itself reliably. Opening in append mode creates only when absent
// and never truncates an existing database.
const databaseFile = await open(databasePath, "a");
await databaseFile.close();
