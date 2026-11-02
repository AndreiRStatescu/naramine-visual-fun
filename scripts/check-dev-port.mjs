import { createServer } from "node:net";

const host = "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid PORT: ${String(process.env.PORT)}`);
}

try {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `${host}:${port} is already in use. Stop the existing app before running make up so SQLite migrations can acquire their lock.`,
          ),
        );
        return;
      }
      reject(error);
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
} catch (error) {
  console.error(
    `Startup preflight failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
