import type { Request, Response } from "express";
import type { ZodType } from "zod";
import { ApiError } from "../../shared/http/api-error";
import {
  AttachEvidenceSchema,
  AuthorizeCommitmentSchema,
  SendSummarySchema,
  VerbalAgreementSchema,
  toCommitmentResponse,
} from "./commitments.types";
import {
  CommitmentsService,
  commitmentsService,
} from "./commitments.service";

function routeParameter(
  value: string | string[] | undefined,
  field: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(422, "VALIDATION_ERROR", `${field} no es válido.`, {
      field,
    });
  }
  return value;
}

function actorId(request: Request): string | undefined {
  const value = request.headers["x-actor-id"];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "El cuerpo de la solicitud no cumple el contrato.",
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

export class CommitmentsController {
  constructor(private readonly service: CommitmentsService) {}

  authorize = async (request: Request, response: Response) => {
    const commitment = await this.service.authorizeCommitment(
      routeParameter(request.params.operationId, "operationId"),
      parseBody(AuthorizeCommitmentSchema, request.body),
      actorId(request),
    );
    response.status(201).json(toCommitmentResponse(commitment));
  };

  list = async (request: Request, response: Response) => {
    const history = await this.service.listCommitments(
      routeParameter(request.params.operationId, "operationId"),
    );
    response.status(200).json(history.map(toCommitmentResponse));
  };

  recordVerbalAgreement = async (
    request: Request,
    response: Response,
  ) => {
    const commitment = await this.service.recordVerbalAgreement(
      routeParameter(request.params.commitmentId, "commitmentId"),
      parseBody(VerbalAgreementSchema, request.body),
      actorId(request),
    );
    response.status(200).json(toCommitmentResponse(commitment));
  };

  attachEvidence = async (request: Request, response: Response) => {
    const commitment = await this.service.attachEvidence(
      routeParameter(request.params.commitmentId, "commitmentId"),
      parseBody(AttachEvidenceSchema, request.body),
      actorId(request),
    );
    response.status(200).json(toCommitmentResponse(commitment));
  };

  enqueueSummary = async (request: Request, response: Response) => {
    const commitment = await this.service.enqueueSummary(
      routeParameter(request.params.commitmentId, "commitmentId"),
      parseBody(SendSummarySchema, request.body),
      actorId(request),
    );
    response.status(202).json(toCommitmentResponse(commitment));
  };
}

export const commitmentsController = new CommitmentsController(
  commitmentsService,
);
