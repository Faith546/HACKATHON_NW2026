import type { Mandate } from "../domain/mandate.js";
import type { Operation } from "../domain/operation.js";

// DEMO/FIXTURE ONLY. These values are invented for the hackathon spike and are
// not production logistics data.
export const demoOperation: Operation = {
  operationId: "op_textiles_pacifico_demo",
  fixture: true,
  customerName: "Textiles Pacifico",
  route: {
    origin: "Manzanillo",
    destination: "Guadalajara",
  },
  cargo: {
    description: "container",
    quantity: 1,
  },
  timezone: "America/Mexico_City",
  currency: "MXN",
};

// Thursday following the fixed hackathon date (2026-08-29).
export const demoMandate: Mandate = {
  operationId: demoOperation.operationId,
  version: 1,
  fixture: true,
  currency: "MXN",
  maxTotalMinor: 900000,
  allInRequired: true,
  pickup: {
    date: "2026-09-03",
    windowStart: "08:00",
    windowEnd: "14:00",
    timezone: "America/Mexico_City",
  },
};

export const demoInboundCarrierId = "carrier_inbound_demo";
