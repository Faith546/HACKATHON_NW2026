import { Router } from "express";
import { carriersController } from "./carriers.controller";
import { asyncHandler } from "../../shared/http/async-handler";

export const carriersRouter = Router();

carriersRouter.get("/", asyncHandler(carriersController.list));
carriersRouter.post("/", asyncHandler(carriersController.create));
carriersRouter.post("/:carrierId/activate", asyncHandler(carriersController.activate));
carriersRouter.delete("/:carrierId", asyncHandler(carriersController.remove));
