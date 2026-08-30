import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { ApiError } from "./api-error";

export interface ErrorResponse {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export const notFoundHandler: RequestHandler = (request, _response, next) => {
  next(
    new ApiError(
      404,
      "ROUTE_NOT_FOUND",
      `No existe la ruta ${request.method} ${request.originalUrl}.`,
    ),
  );
};

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _request,
  response,
  _next,
) => {
  let apiError: ApiError;

  if (error instanceof ApiError) {
    apiError = error;
  } else if (error instanceof ZodError) {
    apiError = new ApiError(
      422,
      "VALIDATION_ERROR",
      "La solicitud no cumple el contrato esperado.",
      { issues: error.issues },
    );
  } else if (error instanceof SyntaxError && "body" in error) {
    apiError = new ApiError(
      400,
      "INVALID_JSON",
      "El cuerpo de la solicitud no contiene JSON válido.",
    );
  } else if (isSqliteConstraintError(error)) {
    apiError = new ApiError(
      409,
      "BUSINESS_CONSTRAINT_VIOLATION",
      "La operación viola una restricción de integridad.",
    );
  } else {
    console.error("Internal Server Error:", error);
    apiError = new ApiError(
      500,
      "INTERNAL_ERROR",
      "Ocurrió un error interno inesperado.",
    );
  }

  const body: ErrorResponse = {
    code: apiError.code,
    message: apiError.message,
  };

  if (apiError.details !== undefined) {
    body.details = apiError.details;
  }

  response.status(apiError.status).json(body);
};

function isSqliteConstraintError(
  error: unknown,
): error is Error & { code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}
