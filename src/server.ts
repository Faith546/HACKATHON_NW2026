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
    const { operatorId, customerName, containerNumber, origin, destination } = req.body;
    const [operation] = await db.insert(operations).values({
      customerName: customerName || "Unknown",
      containerNumber: containerNumber || "Unknown",
      origin: origin || "Unknown",
      destination: destination || "Unknown",
      status: "CREATED"
    }).returning();
    
    await db.insert(auditEvents).values({
      operationId: operation.id,
      eventType: "OperationCreated",
      actorType: "INTERNAL_OPERATOR",
      details: { operatorId }
    });

    res.status(201).json(operation);
  } catch (err) {
    res.status(500).json({ error: "Internal server error", details: err });
  }
});

app.post("/api/v1/operations/:operationId/mandates", async (req, res) => {
  try {
    const { operationId } = req.params;
    const { targetDate, maxPriceCents } = req.body;

    const [mandate] = await db.insert(mandates).values({
      operationId,
      pickupDate: targetDate || "2026-01-01",
      pickupStart: "00:00",
      pickupEnd: "23:59",
      maxTotalPriceCents: maxPriceCents || 900000,
      version: 1,
      status: "ACTIVE"
    }).returning();

    res.status(201).json(mandate);
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
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
    const { operationId, carrierId, offeredPriceCents, isValid, mandateId } = req.body;

    const [quote] = await db.insert(quotes).values({
      operationId,
      negotiationId,
      carrierId,
      basePriceCents: offeredPriceCents,
      totalPriceCents: offeredPriceCents,
      pickupDate: "2026-01-01",
      pickupTime: "12:00",
      mandateId,
      validUntil: new Date().toISOString(),
      valid: isValid ? 1 : 0
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
    const { quoteId, carrierId, agreedPriceCents, mandateId } = req.body;

    const [commitment] = await db.insert(commitments).values({
      operationId,
      quoteId,
      carrierId,
      totalPriceCents: agreedPriceCents,
      pickupAt: "2026-01-01T12:00:00Z",
      mandateId,
      status: "PROPOSED"
    }).returning();

    res.status(201).json(commitment);
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/v1/operations/:operationId/incidents", async (req, res) => {
  try {
    const { operationId } = req.params;
    const { description, mandateId } = req.body;

    const [incident] = await db.insert(incidents).values({
      operationId,
      description,
      type: "OTHER",
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
