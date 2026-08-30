import { ApiError } from "../../shared/http/api-error";
import { mandatesRepository } from "./mandates.repository";
import type { CreateMandateVersionInput } from "./mandates.types";
import { toMandateResponse } from "./mandates.types";

export class MandatesService {
  async getActiveMandate(operationId: string) {
    const mandate = mandatesRepository.getActiveMandate(operationId);
    if (!mandate) {
      throw new ApiError(
        404,
        "RESOURCE_NOT_FOUND",
        "No hay un mandato activo para esta operación.",
        { operationId },
      );
    }
    return toMandateResponse(mandate);
  }

  async createMandateVersion(
    operationId: string,
    input: CreateMandateVersionInput,
    actorId?: string,
  ) {
    return toMandateResponse(
      mandatesRepository.createMandateVersion(operationId, input, actorId),
    );
  }
}

export const mandatesService = new MandatesService();
