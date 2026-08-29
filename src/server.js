import express from "express";
import swaggerUi from "swagger-ui-express";
import yaml from "js-yaml";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const projectRoot = path.resolve(currentDir, "..");
const openApiPath = path.join(projectRoot, "openapi.yaml");
const openApiDocument = yaml.load(fs.readFileSync(openApiPath, "utf8"));

const app = express();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get("/", (_request, response) => response.redirect("/docs"));
app.get("/openapi.yaml", (_request, response) => response.sendFile(openApiPath));

app.use(
  "/docs",
  swaggerUi.serve,
  swaggerUi.setup(openApiDocument, {
    customSiteTitle: "NextWave Voice Logistics API",
    explorer: true,
    swaggerOptions: {
      displayRequestDuration: true,
      filter: true,
      persistAuthorization: true,
      tryItOutEnabled: true
    }
  })
);

// Único endpoint funcional del preview. El resto constituye el contrato de la
// API que se implementará sobre el monolito Express de la demo.
app.get("/api/v1/health", (_request, response) => {
  response.json({ status: "ok", service: "nextwave-voice-logistics-api" });
});

app.listen(port, host, () => {
  process.stdout.write(`Swagger UI: http://${host}:${port}/docs\n`);
  process.stdout.write(`OpenAPI YAML: http://${host}:${port}/openapi.yaml\n`);
});
