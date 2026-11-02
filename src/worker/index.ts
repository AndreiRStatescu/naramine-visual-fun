import { pathToFileURL } from "node:url";

export async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  // Config and Prisma read environment variables at module initialization, so
  // they must be imported only after the native worker has loaded `.env`.
  const { runWorker } = await import("./worker");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await runWorker({ signal: controller.signal });
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;
if (entryPoint) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
