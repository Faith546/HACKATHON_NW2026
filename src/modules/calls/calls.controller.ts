import type { Request, Response } from "express";
import { ApiError } from "../../shared/http/api-error";
import type { CallsService } from "./calls.service";
import {
  callBriefOutcomes,
  enqueueCallPurposes,
  toCallResponse,
  type CallBriefInput,
  type EnqueueOutboundCallInput,
} from "./calls.types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function routeParameter(value: string | string[], field: string): string {
  if (Array.isArray(value) || value.trim() === "") {
    throw new ApiError(422, "VALIDATION_ERROR", `${field} no es válido.`, {
      field,
    });
  }
  return value;
}

function stringArray(
  value: unknown,
  field: string,
  required: boolean,
): string[] | undefined {
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ApiError(422, "VALIDATION_ERROR", `${field} debe ser un arreglo de texto.`, {
      field,
    });
  }
  return value;
}

function parseEnqueueBody(value: unknown): Omit<EnqueueOutboundCallInput, "operationId"> {
  if (!isRecord(value)) {
    throw new ApiError(422, "VALIDATION_ERROR", "El cuerpo de la solicitud es obligatorio.");
  }
  if (typeof value.carrierId !== "string" || value.carrierId.trim() === "") {
    throw new ApiError(422, "VALIDATION_ERROR", "carrierId es obligatorio.", {
      field: "carrierId",
    });
  }
  if (
    value.negotiationId !== undefined &&
    value.negotiationId !== null &&
    typeof value.negotiationId !== "string"
  ) {
    throw new ApiError(422, "VALIDATION_ERROR", "negotiationId debe ser texto o null.", {
      field: "negotiationId",
    });
  }
  if (
    typeof value.purpose !== "string" ||
    !enqueueCallPurposes.includes(value.purpose as EnqueueOutboundCallInput["purpose"])
  ) {
    throw new ApiError(422, "VALIDATION_ERROR", "purpose no es válido.", {
      field: "purpose",
    });
  }

  return {
    carrierId: value.carrierId,
    negotiationId: value.negotiationId as string | null | undefined,
    purpose: value.purpose as EnqueueOutboundCallInput["purpose"],
  };
}

function parseBriefBody(value: unknown): CallBriefInput {
  if (!isRecord(value)) {
    throw new ApiError(422, "VALIDATION_ERROR", "El cuerpo de la solicitud es obligatorio.");
  }
  if (typeof value.summary !== "string" || value.summary.trim() === "") {
    throw new ApiError(422, "VALIDATION_ERROR", "summary es obligatorio.", {
      field: "summary",
    });
  }
  if (
    typeof value.outcome !== "string" ||
    !callBriefOutcomes.includes(value.outcome as CallBriefInput["outcome"])
  ) {
    throw new ApiError(422, "VALIDATION_ERROR", "outcome no es válido.", {
      field: "outcome",
    });
  }

  return {
    summary: value.summary,
    outcome: value.outcome as CallBriefInput["outcome"],
    mentions: stringArray(value.mentions, "mentions", true) ?? [],
    objections: stringArray(value.objections, "objections", false),
    actions: stringArray(value.actions, "actions", true) ?? [],
    nextSteps: stringArray(value.nextSteps, "nextSteps", false),
  };
}

export class CallsController {
  constructor(private readonly service: CallsService) {}

  enqueueOutbound = async (request: Request, response: Response) => {
    const body = parseEnqueueBody(request.body);
    const call = await this.service.enqueueOutbound({
      ...body,
      operationId: routeParameter(request.params.operationId, "operationId"),
    });
    response.status(202).json(toCallResponse(call));
  };

  getCall = async (request: Request, response: Response) => {
    const call = await this.service.getById(
      routeParameter(request.params.callId, "callId"),
    );
    response.status(200).json(toCallResponse(call));
  };

  saveBrief = async (request: Request, response: Response) => {
    const brief = await this.service.saveBrief(
      routeParameter(request.params.callId, "callId"),
      parseBriefBody(request.body),
    );
    response.status(200).json(brief);
  };
}
