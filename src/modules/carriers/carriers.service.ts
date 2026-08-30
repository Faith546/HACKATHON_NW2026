import { ApiError } from "../../shared/http/api-error";
import { carrierRepository } from "./carriers.repository";
import type { CreateCarrierInput } from "./carriers.types";
import { toCarrierResponse } from "./carriers.types";

export class CarriersService {
  async listCarriers() {
    return carrierRepository.findAll().map(toCarrierResponse);
  }

  async createCarrier(input: CreateCarrierInput) {
    try {
      return toCarrierResponse(carrierRepository.create(input));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("UNIQUE constraint failed: carriers.phone")) {
        throw new ApiError(
          409,
          "DUPLICATE_CARRIER_PHONE",
          "Ya existe un carrier con ese teléfono.",
          { phone: input.phone },
        );
      }
      throw error;
    }
  }

  async deleteCarrier(carrierId: string) {
    const carrier = carrierRepository.deactivate(carrierId);
    if (!carrier) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "El carrier no existe.", {
        carrierId,
      });
    }
  }
}

export const carriersService = new CarriersService();
