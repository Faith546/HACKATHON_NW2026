import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

export const requestContext: RequestHandler = (request, response, next) => {
  const suppliedRequestId = request.header("x-request-id")?.trim();
  const requestId = suppliedRequestId || `req_${randomUUID()}`;

  response.setHeader("x-request-id", requestId);
  next();
};
