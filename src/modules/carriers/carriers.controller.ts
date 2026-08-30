import type { Request, Response } from "express";
import { carriersService } from "./carriers.service";
import { CreateCarrierSchema } from "./carriers.types";
import { ApiError } from "../../shared/http/api-error";

export class CarriersController {
  async list(_req: Request, res: Response) {
    res.status(200).json(await carriersService.listCarriers());
  }

  async create(req: Request, res: Response) {
    const parsed = CreateCarrierSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Datos del carrier inválidos.",
        parsed.error.format(),
      );
    }

    res.status(201).json(await carriersService.createCarrier(parsed.data));
  }
}

export const carriersController = new CarriersController();
