import { createApp } from "./app";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const app = createApp();

const server = app.listen(port, host, () => {
  process.stdout.write(`API: http://${host}:${port}/api/v1\n`);
  process.stdout.write(`Swagger UI: http://${host}:${port}/docs\n`);
  process.stdout.write(`OpenAPI YAML: http://${host}:${port}/openapi.yaml\n`);
});

function shutdown(signal: string): void {
  process.stdout.write(`${signal} received, closing HTTP server\n`);
  server.close((error) => {
    if (error) {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
