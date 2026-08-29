import type { Request, Response } from "express";
import { carrierRepository } from "./carriers.repository";
import { CreateCarrierSchema } from "./carriers.types";
import { ApiError } from "../../shared/http/api-error";

export class CarriersController {
  async list(_req: Request, res: Response) {
    const allCarriers = await carrierRepository.findAll();
    res.status(200).json(allCarriers);
  }

  async create(req: Request, res: Response) {
    const parsed = CreateCarrierSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_INPUT", "Datos del carrier inválidos", parsed.error.format());
    }

    try {
      const carrier = await carrierRepository.create(parsed.data);
      res.status(201).json(carrier);
    } catch (err: any) {
      if (err.message && err.message.includes("UNIQUE constraint failed")) {
        throw new ApiError(409, "DUPLICATE_PHONE", "Ya existe un carrier con ese teléfono.");
      }
      throw err;
    }
  }
}

export const carriersController = new CarriersController();
