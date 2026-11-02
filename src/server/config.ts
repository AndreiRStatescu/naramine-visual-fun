import path from "node:path";

import { z } from "zod";

const environmentSchema = z.object({
  IEVCS_DATA_ROOT: z.string().trim().min(1).optional(),
  // Kept as a compatibility alias for early local checkouts.
  IEVCS_DATA_DIR: z.string().trim().min(1).optional(),
  DATABASE_URL: z.string().trim().min(1).optional(),
  CODEX_ADAPTER: z.enum(["fake", "codex"]).default("fake"),
  IEVCS_MAX_REFERENCE_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(100 * 1_024 * 1_024)
    .default(20 * 1_024 * 1_024),
});

const environment = environmentSchema.parse(process.env);
const configuredDataRoot =
  environment.IEVCS_DATA_ROOT ?? environment.IEVCS_DATA_DIR ?? "data";
const dataRoot = path.isAbsolute(configuredDataRoot)
  ? path.normalize(configuredDataRoot)
  : path.join(/* turbopackIgnore: true */ process.cwd(), configuredDataRoot);

function normalizedDatabaseUrl(configuredUrl: string | undefined): string {
  if (!configuredUrl) {
    return `file:${path.join(
      /* turbopackIgnore: true */ dataRoot,
      "ievcs.db",
    )}`;
  }
  if (!configuredUrl.startsWith("file:")) {
    throw new Error(
      "IEVCS requires a SQLite DATABASE_URL beginning with file:",
    );
  }

  const fileAndQuery = configuredUrl.slice("file:".length);
  const queryIndex = fileAndQuery.indexOf("?");
  const fileName =
    queryIndex === -1 ? fileAndQuery : fileAndQuery.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : fileAndQuery.slice(queryIndex);
  if (!fileName)
    throw new Error("DATABASE_URL must name a SQLite database file");

  // Prisma resolves relative SQLite URLs against the schema directory. Runtime
  // datasource overrides do not reliably share that base, so make it explicit.
  const absoluteFileName = path.isAbsolute(fileName)
    ? fileName
    : path.resolve(
        /* turbopackIgnore: true */ process.cwd(),
        "prisma",
        fileName,
      );
  return `file:${absoluteFileName}${query}`;
}

const databaseUrl = normalizedDatabaseUrl(environment.DATABASE_URL);
const databaseFilePath = databaseUrl.slice("file:".length).split("?", 1)[0];

export const config = Object.freeze({
  dataRoot,
  // `dataDir` is a convenient compatibility name for callers that predate
  // IEVCS_DATA_ROOT.
  dataDir: dataRoot,
  projectsDir: path.join(dataRoot, "projects"),
  databaseUrl,
  databaseFilePath,
  maxReferenceBytes: environment.IEVCS_MAX_REFERENCE_BYTES,
  codexAdapterName: environment.CODEX_ADAPTER,
});

export type AppConfig = typeof config;
