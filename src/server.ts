import express from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import yaml from "yamljs";
import path from "path";
import { db } from "./db";
import { 
  operations, mandates, campaigns, negotiations, quotes, 
  commitments, incidents, auditEvents 
} from "./db/schema";
import { eq } from "drizzle-orm";

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // For Twilio webhooks

// Swagger UI
const swaggerDocument = yaml.load(path.join(process.cwd(), "openapi.yaml"));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Health check
app.get("/api/v1/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// ==========================================
// Operations & Mandates
// ==========================================

app.post("/api/v1/operations", async (req, res) => {
  try {
    const {
      operatorId,
      customerName,
      containerNumber,
      origin,
      destination,
      service = "DRAYAGE",
      notes,
      mandate,
    } = req.body;
    const created = await db.transaction(async (tx) => {
      const [operation] = await tx.insert(operations).values({
        customerName: customerName || "Unknown",
        containerNumber: containerNumber || "Unknown",
        origin: origin || "Unknown",
        destination: destination || "Unknown",
        service,
        notes,
        status: "CREATED",
      }).returning();

      const [initialMandate] = await tx.insert(mandates).values({
        operationId: operation.id,
        version: 1,
        status: "ACTIVE",
        maxTotalPriceCents: Math.round(mandate.maxTotalPrice * 100),
        currency: mandate.currency,
        pickupDate: mandate.pickupDate,
        notes: mandate.notes,
      }).returning();

      await tx.insert(auditEvents).values([
        {
          operationId: operation.id,
          mandateId: initialMandate.id,
          eventType: "OPERATION_CREATED",
          actorType: "INTERNAL_OPERATOR",
          actorId: operatorId,
          entityType: "OPERATION",
          entityId: operation.id,
          payloadJson: JSON.stringify({ initialMandateId: initialMandate.id }),
        },
        {
          operationId: operation.id,
          mandateId: initialMandate.id,
          eventType: "MANDATE_CREATED",
          actorType: "INTERNAL_OPERATOR",
          actorId: operatorId,
          entityType: "MANDATE",
          entityId: initialMandate.id,
          payloadJson: JSON.stringify({ version: 1 }),
        },
      ]);

      return { operation, initialMandate };
    });

    res.status(201).json({
      ...created.operation,
      mandate: created.initialMandate,
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error", details: err });
  }
});

// ==========================================
// Campaigns & Negotiations
// ==========================================

app.post("/api/v1/operations/:operationId/campaigns", async (req, res) => {
  try {
    const { operationId } = req.params;
    
    const [campaign] = await db.insert(campaigns).values({
      operationId,
      status: "QUEUED",
      requestedCarriers: 3
    }).returning();

    res.status(202).json(campaign);
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/v1/negotiations/:negotiationId/quotes", async (req, res) => {
  try {
    const { negotiationId } = req.params;
    const {
      operationId,
      carrierId,
      totalPrice,
      currency = "MXN",
      pickupDate,
      notes,
      isValid,
      mandateId,
    } = req.body;

    const [quote] = await db.insert(quotes).values({
      operationId,
      negotiationId,
      carrierId,
      totalPriceCents: Math.round(totalPrice * 100),
      currency,
      pickupDate,
      notes,
      mandateId,
      validUntil: new Date().toISOString(),
      valid: Boolean(isValid),
    }).returning();

    res.status(201).json(quote);
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ==========================================
// Commitments & Incidents
// ==========================================

app.post("/api/v1/operations/:operationId/commitments/authorize", async (req, res) => {
  try {
    const { operationId } = req.params;
    const {
      quoteId,
      carrierId,
      agreedPriceCents,
      currency = "MXN",
      pickupDate,
      mandateId,
    } = req.body;

    const [commitment] = await db.insert(commitments).values({
      operationId,
      quoteId,
      carrierId,
      totalPriceCents: agreedPriceCents,
      currency,
      pickupDate,
      mandateId,
      status: "PROPOSED",
    }).returning();

    res.status(201).json(commitment);
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/v1/operations/:operationId/incidents", async (req, res) => {
  try {
    const { operationId } = req.params;
    const { callId, type = "GENERAL", description, reportedBy, mandateId } = req.body;

    const [incident] = await db.insert(incidents).values({
      operationId,
      callId,
      description,
      reportedBy,
      type,
      status: "OPEN",
      mandateId
    }).returning();

    res.status(201).json(incident);
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ==========================================
// Twilio Webhooks
// ==========================================

app.post("/api/v1/webhooks/twilio/voice", (req, res) => {
  const twiml = `<Response><Connect><Stream url="wss://${req.headers.host}/ws/twilio-media" /></Connect></Response>`;
  res.type('text/xml');
  res.send(twiml);
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: "Not Found" });
});

// Start Server
app.listen(port, () => {
  console.log(`Express server running on http://localhost:${port}`);
  console.log(`Swagger docs available at http://localhost:${port}/docs`);
});
