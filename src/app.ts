import express, { type Express } from "express";
import swaggerUi from "swagger-ui-express";
import yaml from "yamljs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCoreRouter } from "./modules/core/core.router";
import { createVoiceRouter } from "./modules/voice/voice.router";
import {
  errorHandler,
  notFoundHandler,
} from "./shared/http/error-handler";
import { requestContext } from "./shared/http/request-context";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "..");
const openApiPath = path.join(projectRoot, "openapi.yaml");

export interface CreateAppOptions {
  apiPrefix?: string;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
  const apiPrefix = options.apiPrefix ?? "/api/v1";
  const openApiDocument = yaml.load(openApiPath);

  app.disable("x-powered-by");
  app.use(requestContext);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.get("/", (_request, response) => response.redirect("/docs"));
  app.get("/openapi.yaml", (_request, response) =>
    response.sendFile(openApiPath),
  );
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
        tryItOutEnabled: true,
      },
    }),
  );

  app.use(apiPrefix, createCoreRouter());
  app.use(apiPrefix, createVoiceRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
