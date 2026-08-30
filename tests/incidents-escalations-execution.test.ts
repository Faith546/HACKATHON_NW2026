import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import {
  auditEvents,
  calls,
  campaigns,
  carriers,
  commitments,
  escalations,
  incidents,
  mandates,
  negotiations,
  operations,
  quotes,
} from "../src/db/schema";
import { createIncidentsService } from "../src/modules/incidents/incidents.service";
import {
  createIncidentsRouter,
  createOperationIncidentsRouter,
} from "../src/modules/incidents/incidents.routes";
import { createEscalationsService } from "../src/modules/escalations/escalations.service";
import {
  createEscalationsRouter,
  createOperationEscalationsRouter,
} from "../src/modules/escalations/escalations.routes";
import {
  TwilioHumanConferenceGateway,
  type HumanConferenceGateway,
  type JoinHumanConferenceInput,
  type TwilioConferenceApi,
} from "../src/modules/escalations/human-conference.gateway";
import { IntegrationService } from "../src/modules/integration/integration.service";
import { createExecutionService } from "../src/modules/execution/execution.service";
import { createExecutionRouter } from "../src/modules/execution/execution.routes";
import { errorHandler } from "../src/shared/http/error-handler";
import { InMemoryJobQueue } from "../src/shared/queue/in-memory-job-queue";
import {
  createBusinessFlowDatabase,
  startTestApp,
  type BusinessFlowDatabase,
} from "./support/business-flow-database";

const t0 = "2026-08-29T12:00:00.000Z";
const t1 = "2026-08-29T13:00:00.000Z";

describe("Incidents endpoints", () => {
  it("persists and audits incidents, then evaluates every mandate violation deterministically", async () => {
    const { sqlite, database } = createBusinessFlowDatabase();
    seedOperation(database, {
      operationId: "op_inc",
      status: "IN_TRANSIT",
    });
    seedMandate(database, "op_inc", "man_inc", 900_000, "2026-09-03");
    seedCall(database, {
      callId: "call_inc",
      operationId: "op_inc",
      status: "COMPLETED",
      purpose: "INCIDENT",
    });
    const service = createIncidentsService({
      database,
      now: () => new Date(t0),
      createIncidentId: () => "inc_test",
      createAuditId: (() => {
        let sequence = 0;
        return () => `evt_inc_${++sequence}`;
      })(),
    });
    const app = express();
    app.use(express.json());
    app.use(
      "/operations/:operationId/incidents",
      createOperationIncidentsRouter(service),
    );
    app.use("/incidents", createIncidentsRouter(service));
    app.use(errorHandler);
    const http = await startTestApp(app);

    try {
      const report = await fetch(
        `${http.baseUrl}/operations/op_inc/incidents`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-actor-id": "driver_1",
          },
          body: JSON.stringify({
            callId: "call_inc",
            type: "GENERAL",
            description: "El pickup debe cambiar y hay un sobrecosto.",
            reportedBy: "Juan",
          }),
        },
      );
      assert.equal(report.status, 201);
      const reported = (await report.json()) as Record<string, unknown>;
      assert.equal(reported.id, "inc_test");
      assert.equal(reported.status, "OPEN");

      const evaluation = await fetch(
        `${http.baseUrl}/incidents/inc_test/evaluate-change`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            proposedPickupDate: "2026-09-04",
            proposedTotalPrice: 9500,
            notes: "Cambio solicitado por el conductor",
          }),
        },
      );
      assert.equal(evaluation.status, 200);
      assert.deepEqual(await evaluation.json(), {
        allowed: false,
        code: "PRICE_EXCEEDS_MANDATE",
        mandateId: "man_inc",
        reasons: [
          "El precio total de 9500 MXN supera el máximo de 9000 MXN.",
          "La fecha de pickup 2026-09-04 no coincide con la fecha autorizada 2026-09-03.",
        ],
      });

      const stored = database
        .select()
        .from(incidents)
        .where(eq(incidents.id, "inc_test"))
        .get();
      assert.equal(stored?.status, "NEEDS_ESCALATION");
      assert.equal(stored?.evaluationCode, "PRICE_EXCEEDS_MANDATE");
      assert.equal(stored?.mandateId, "man_inc");
      assert.deepEqual(JSON.parse(stored?.proposedChangeJson ?? "{}"), {
        proposedPickupDate: "2026-09-04",
        proposedTotalPrice: 9500,
        notes: "Cambio solicitado por el conductor",
      });
      const events = database
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.operationId, "op_inc"))
        .all();
      assert.deepEqual(
        events.map((event) => event.eventType),
        ["INCIDENT_REPORTED", "INCIDENT_CHANGE_EVALUATED"],
      );
    } finally {
      await http.close();
      sqlite.close();
    }
  });

  it("allows an in-mandate change and rejects a call from another operation", async () => {
    const { sqlite, database } = createBusinessFlowDatabase();
    seedOperation(database, { operationId: "op_a", status: "IN_TRANSIT" });
    seedOperation(database, { operationId: "op_b", status: "IN_TRANSIT" });
    seedMandate(database, "op_a", "man_a", 900_000, "2026-09-03");
    seedCall(database, {
      callId: "call_a",
      operationId: "op_a",
      status: "IN_PROGRESS",
      purpose: "INCIDENT",
    });
    seedCall(database, {
      callId: "call_b",
      operationId: "op_b",
      status: "IN_PROGRESS",
      purpose: "INCIDENT",
    });
    const service = createIncidentsService({
      database,
      createIncidentId: () => "inc_allowed",
    });
    const app = express();
    app.use(express.json());
    app.use(
      "/operations/:operationId/incidents",
      createOperationIncidentsRouter(service),
    );
    app.use("/incidents", createIncidentsRouter(service));
    app.use(errorHandler);
    const http = await startTestApp(app);

    try {
      const mismatch = await fetch(
        `${http.baseUrl}/operations/op_a/incidents`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            callId: "call_b",
            type: "GENERAL",
            description: "Contexto incorrecto",
          }),
        },
      );
      assert.equal(mismatch.status, 409);
      assert.equal((await mismatch.json()).code, "CALL_OPERATION_MISMATCH");

      const report = await fetch(
        `${http.baseUrl}/operations/op_a/incidents`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            callId: "call_a",
            type: "GENERAL",
            description: "Cambio dentro de autoridad",
          }),
        },
      );
      assert.equal(report.status, 201);
      const evaluation = await fetch(
        `${http.baseUrl}/incidents/inc_allowed/evaluate-change`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            proposedPickupDate: "2026-09-03",
            proposedTotalPrice: 8500,
          }),
        },
      );
      assert.equal(evaluation.status, 200);
      assert.equal((await evaluation.json()).code, "ALLOWED");
      assert.equal(service.getIncident("inc_allowed")?.status, "ALLOWED_CHANGE");

      const invalidDate = await fetch(
        `${http.baseUrl}/incidents/inc_allowed/evaluate-change`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ proposedPickupDate: "2026-02-31" }),
        },
      );
      assert.equal(invalidDate.status, 422);
    } finally {
      await http.close();
      sqlite.close();
    }
  });
});

describe("Escalations endpoints and Twilio conference gateway", () => {
  it("auto-joins the configured human from an active quote call", async () => {
    const { sqlite, database } = createBusinessFlowDatabase();
    seedOperation(database, { operationId: "op_quote_handoff", status: "SOURCING" });
    database.insert(carriers).values({
      id: "car_quote_handoff",
      name: "Carrier Quote Handoff",
      dispatcherName: "Dispatcher Handoff",
      phone: "+525555555550",
      score: 80,
      active: true,
      createdAt: t0,
    }).run();
    seedCall(database, {
      callId: "call_quote_handoff",
      operationId: "op_quote_handoff",
      carrierId: "car_quote_handoff",
      status: "IN_PROGRESS",
      purpose: "QUOTE",
      twilioCallSid: "CA_QUOTE_HANDOFF",
    });
    const gateway = new CapturingConferenceGateway();
    const queue = new InMemoryJobQueue({ concurrency: 1, maxRetries: 0 });
    const escalationsService = createEscalationsService({
      database,
      queue,
      conferenceGateway: gateway,
      createEscalationId: () => "esc_quote_handoff",
    });
    const integration = new IntegrationService({
      escalationsService,
      humanEscalationPhone: "+525555555556",
    });

    try {
      const queued = await integration.executeVoiceTool({
        name: "requestEscalation",
        context: {
          callId: "call_quote_handoff",
          operationId: "op_quote_handoff",
          carrierId: "car_quote_handoff",
          negotiationId: "neg_quote_handoff",
          actorType: "CARRIER",
          mandateId: null,
        },
        arguments: {
          reason: "HUMAN_REQUESTED",
          contextSummary: "El carrier pidió hablar con una persona.",
        },
      }) as { status: string };
      assert.equal(queued.status, "DIALING_HUMAN");
      await queue.onIdle();
      assert.equal(
        escalationsService.getEscalation("esc_quote_handoff")?.status,
        "HUMAN_JOINED",
      );
      assert.equal(gateway.inputs.length, 1);
      assert.equal(gateway.inputs[0]?.providerCallId, "CA_QUOTE_HANDOFF");
      assert.equal(gateway.inputs[0]?.humanPhone, "+525555555556");
    } finally {
      sqlite.close();
    }
  });

  it("validates the active context and persists the queued and joined conference states", async () => {
    const { sqlite, database } = createBusinessFlowDatabase();
    seedOperation(database, { operationId: "op_esc", status: "IN_TRANSIT" });
    seedCall(database, {
      callId: "call_esc",
      operationId: "op_esc",
      status: "IN_PROGRESS",
      purpose: "INCIDENT",
      twilioCallSid: "CA_ACTIVE",
    });
    database.insert(incidents).values({
      id: "inc_esc",
      operationId: "op_esc",
      callId: "call_esc",
      type: "GENERAL",
      description: "Cambio fuera de mandato",
      status: "NEEDS_ESCALATION",
      evaluationCode: "DATE_OUTSIDE_MANDATE",
      createdAt: t0,
    }).run();
    const gateway = new CapturingConferenceGateway();
    const queue = new InMemoryJobQueue({ concurrency: 1, maxRetries: 0 });
    const service = createEscalationsService({
      database,
      queue,
      conferenceGateway: gateway,
      createEscalationId: () => "esc_test",
      createAuditId: (() => {
        let sequence = 0;
        return () => `evt_esc_${++sequence}`;
      })(),
    });
    const app = express();
    app.use(express.json());
    app.use(
      "/operations/:operationId/escalations",
      createOperationEscalationsRouter(service),
    );
    app.use("/escalations", createEscalationsRouter(service));
    app.use(errorHandler);
    const http = await startTestApp(app);

    try {
      const request = await fetch(
        `${http.baseUrl}/operations/op_esc/escalations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            callId: "call_esc",
            incidentId: "inc_esc",
            reason: "OUTSIDE_MANDATE",
            contextSummary: "El conductor solicita una fecha no autorizada.",
            requestedHumanPhone: "+525555555555",
          }),
        },
      );
      assert.equal(request.status, 201);
      assert.equal((await request.json()).status, "REQUESTED");
      assert.equal(
        database.select().from(operations).where(eq(operations.id, "op_esc")).get()?.status,
        "ESCALATED",
      );

      const join = await fetch(
        `${http.baseUrl}/escalations/esc_test/join-human`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ humanPhone: "+525555555556" }),
        },
      );
      assert.equal(join.status, 202);
      assert.equal((await join.json()).status, "DIALING_HUMAN");
      await queue.onIdle();

      const joined = service.getEscalation("esc_test");
      assert.equal(joined?.status, "HUMAN_JOINED");
      assert.equal(joined?.humanPhone, "+525555555556");
      assert.equal(joined?.twilioConferenceSid, "CF_TEST");
      assert.equal(gateway.inputs.length, 1);
      assert.equal(gateway.inputs[0]?.providerCallId, "CA_ACTIVE");
      const humanJoinedAudit = database
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.eventType, "HUMAN_JOINED"))
        .get();
      assert.match(humanJoinedAudit?.payloadJson ?? "", /CF_TEST/);

      const getEscalation = await fetch(
        `${http.baseUrl}/escalations/esc_test`,
      );
      assert.equal(getEscalation.status, 200);
      assert.equal((await getEscalation.json()).status, "HUMAN_JOINED");

      const resolve = await fetch(
        `${http.baseUrl}/escalations/esc_test/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            resolutionSummary: "Humano autorizó el cambio bajo el mandato vigente.",
          }),
        },
      );
      assert.equal(resolve.status, 200);
      assert.equal((await resolve.json()).status, "RESOLVED");
      assert.equal(
        database.select().from(operations).where(eq(operations.id, "op_esc")).get()?.status,
        "IN_TRANSIT",
      );
      assert.equal(
        database.select().from(incidents).where(eq(incidents.id, "inc_esc")).get()?.status,
        "RESOLVED",
      );

      const duplicate = await fetch(
        `${http.baseUrl}/escalations/esc_test/join-human`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ humanPhone: "+525555555556" }),
        },
      );
      assert.equal(duplicate.status, 409);
    } finally {
      await http.close();
      sqlite.close();
    }
  });

  it("rejects inactive calls and records an exhausted gateway job as FAILED", async () => {
    const { sqlite, database } = createBusinessFlowDatabase();
    seedOperation(database, { operationId: "op_inactive", status: "IN_TRANSIT" });
    seedCall(database, {
      callId: "call_inactive",
      operationId: "op_inactive",
      status: "COMPLETED",
      purpose: "INCIDENT",
      twilioCallSid: "CA_ENDED",
    });
    const queue = new InMemoryJobQueue({ concurrency: 1, maxRetries: 0 });
    const service = createEscalationsService({
      database,
      queue,
      conferenceGateway: {
        joinHuman: async () => {
          throw new Error("Twilio unavailable");
        },
      },
      createEscalationId: () => "esc_fail",
    });

    assert.throws(
      () =>
        service.requestEscalation("op_inactive", {
          callId: "call_inactive",
          reason: "HUMAN_REQUESTED",
          contextSummary: "Solicita humano",
        }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "CALL_NOT_ACTIVE",
    );

    database.update(calls).set({ status: "IN_PROGRESS" }).where(eq(calls.id, "call_inactive")).run();
    service.requestEscalation("op_inactive", {
      callId: "call_inactive",
      reason: "HUMAN_REQUESTED",
      contextSummary: "Solicita humano",
    });
    service.joinHuman("esc_fail", { humanPhone: "+525555555555" });
    await queue.onIdle();
    assert.equal(service.getEscalation("esc_fail")?.status, "FAILED");
    sqlite.close();
  });

  it("dials the human first and redirects only the requesting carrier after the human answers", async () => {
    const callsMade: Array<Record<string, unknown>> = [];
    const api: TwilioConferenceApi = {
      redirectCall: async (callSid, twiml) => {
        callsMade.push({ action: "redirect", callSid, twiml });
      },
      findActiveConference: async (friendlyName) => {
        callsMade.push({ action: "find", friendlyName });
        return null;
      },
      addParticipant: async (conferenceReference, input) => {
        callsMade.push({ action: "participant", conferenceReference, ...input });
        return { callSid: "CA_HUMAN", conferenceSid: "CF_REAL" };
      },
      getCallStatus: async (callSid) => {
        callsMade.push({ action: "participant-status", callSid });
        return "in-progress";
      },
    };
    const gateway = new TwilioHumanConferenceGateway(
      {
        fromNumber: "+525555555500",
        discoveryAttempts: 2,
        discoveryIntervalMs: 0,
        participantAnswerAttempts: 1,
        wait: async () => undefined,
      },
      api,
    );
    const result = await gateway.joinHuman({
      escalationId: "esc_twilio",
      operationId: "op_twilio",
      callId: "call_twilio",
      providerCallId: "CA_CARRIER",
      humanPhone: "+525555555501",
    });

    assert.deepEqual(result, {
      conferenceSid: "CF_REAL",
      humanParticipantCallSid: "CA_HUMAN",
    });
    const redirect = callsMade.find((call) => call.action === "redirect");
    assert.equal(redirect?.callSid, "CA_CARRIER");
    assert.match(String(redirect?.twiml), /<Conference/);
    assert.match(String(redirect?.twiml), /record="do-not-record"/);
    assert.doesNotMatch(String(redirect?.twiml), /<Hangup/);
    assert.ok(
      callsMade.findIndex((call) => call.action === "participant") <
        callsMade.findIndex((call) => call.action === "participant-status"),
    );
    assert.ok(
      callsMade.findIndex((call) => call.action === "participant-status") <
        callsMade.findIndex((call) => call.action === "redirect"),
    );

    const retried = await gateway.joinHuman({
      escalationId: "esc_twilio",
      operationId: "op_twilio",
      callId: "call_twilio",
      providerCallId: "CA_CARRIER",
      humanPhone: "+525555555501",
    });
    assert.deepEqual(retried, result);
    assert.equal(
      callsMade.filter((call) => call.action === "redirect").length,
      1,
    );
    assert.equal(
      callsMade.filter((call) => call.action === "participant").length,
      1,
    );
  });

  it("keeps the carrier with Relay when the human does not answer", async () => {
    const callsMade: string[] = [];
    const api: TwilioConferenceApi = {
      redirectCall: async () => {
        callsMade.push("redirect");
      },
      findActiveConference: async () => null,
      addParticipant: async () => {
        callsMade.push("participant");
        return { callSid: "CA_HUMAN_NO_ANSWER", conferenceSid: "CF_WAITING" };
      },
      getCallStatus: async () => {
        callsMade.push("no-answer");
        return "no-answer";
      },
    };
    const gateway = new TwilioHumanConferenceGateway(
      {
        fromNumber: "+525555555500",
        discoveryIntervalMs: 0,
        participantAnswerAttempts: 1,
        wait: async () => undefined,
      },
      api,
    );

    await assert.rejects(
      gateway.joinHuman({
        escalationId: "esc_no_answer",
        operationId: "op_no_answer",
        callId: "call_no_answer",
        providerCallId: "CA_CARRIER_STAYS_WITH_RELAY",
        humanPhone: "+525555555501",
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "HUMAN_DID_NOT_JOIN",
    );
    assert.deepEqual(callsMade, ["participant", "no-answer"]);
  });
});

describe("Execution endpoints", () => {
  it("executes the official pickup and delivery transitions atomically with audit evidence", async () => {
    const { sqlite, database } = createBusinessFlowDatabase();
    seedExecutionContext(database, {
      operationId: "op_exec",
      operationStatus: "PICKUP_PENDING",
      commitmentStatus: "VALID",
    });
    seedCall(database, {
      callId: "call_pickup",
      operationId: "op_exec",
      carrierId: "car_exec",
      status: "IN_PROGRESS",
      purpose: "EXECUTION",
    });
    seedCall(database, {
      callId: "call_delivery",
      operationId: "op_exec",
      carrierId: "car_exec",
      status: "COMPLETED",
      purpose: "DELIVERY",
    });
    const service = createExecutionService({
      database,
      now: () => new Date(t1),
      createAuditId: (() => {
        let sequence = 0;
        return () => `evt_exec_${++sequence}`;
      })(),
    });
    const app = express();
    app.use(express.json());
    app.use("/operations/:operationId", createExecutionRouter(service));
    app.use(errorHandler);
    const http = await startTestApp(app);

    try {
      const pickup = await fetch(
        `${http.baseUrl}/operations/op_exec/pickup/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            callId: "call_pickup",
            occurredAt: t0,
            confirmedBy: "Juan",
            notes: "Contenedor recogido",
          }),
        },
      );
      assert.equal(pickup.status, 200);
      const pickedUp = await pickup.json();
      assert.equal(pickedUp.status, "IN_TRANSIT");
      assert.equal(pickedUp.mandate.maxTotalPrice, 9000);
      assert.equal(
        database.select().from(commitments).where(eq(commitments.id, "com_exec")).get()?.status,
        "IN_EXECUTION",
      );

      const duplicatePickup = await fetch(
        `${http.baseUrl}/operations/op_exec/pickup/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            callId: "call_pickup",
            occurredAt: t0,
            confirmedBy: "Juan",
          }),
        },
      );
      assert.equal(duplicatePickup.status, 409);

      const delivery = await fetch(
        `${http.baseUrl}/operations/op_exec/delivery/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            callId: "call_delivery",
            occurredAt: t1,
            confirmedBy: "Juan",
          }),
        },
      );
      assert.equal(delivery.status, 200);
      assert.equal((await delivery.json()).status, "COMPLETED");
      assert.equal(
        database.select().from(commitments).where(eq(commitments.id, "com_exec")).get()?.status,
        "FULFILLED",
      );
      assert.deepEqual(
        database
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.operationId, "op_exec"))
          .all()
          .map((event) => event.eventType),
        ["PICKUP_CONFIRMED", "DELIVERY_CONFIRMED"],
      );
    } finally {
      await http.close();
      sqlite.close();
    }
  });

  it("rejects pickup without a VALID commitment and delivery outside IN_TRANSIT", () => {
    const { sqlite, database } = createBusinessFlowDatabase();
    seedOperation(database, {
      operationId: "op_no_commitment",
      status: "BOOKED",
    });
    seedMandate(
      database,
      "op_no_commitment",
      "man_no_commitment",
      900_000,
      "2026-09-03",
    );
    seedCall(database, {
      callId: "call_no_commitment",
      operationId: "op_no_commitment",
      status: "IN_PROGRESS",
      purpose: "EXECUTION",
    });
    const service = createExecutionService({ database });

    assert.throws(
      () =>
        service.confirmPickup("op_no_commitment", {
          callId: "call_no_commitment",
          occurredAt: t0,
          confirmedBy: "Juan",
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "VALID_COMMITMENT_REQUIRED",
    );
    assert.throws(
      () =>
        service.confirmDelivery("op_no_commitment", {
          callId: "call_no_commitment",
          occurredAt: t0,
          confirmedBy: "Juan",
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "INVALID_STATE_TRANSITION",
    );
    sqlite.close();
  });

  it("rejects QUOTE or COMMIT calls as pickup evidence", () => {
    const { sqlite, database } = createBusinessFlowDatabase();
    seedExecutionContext(database, {
      operationId: "op_wrong_purpose",
      operationStatus: "BOOKED",
      commitmentStatus: "VALID",
    });
    seedCall(database, {
      callId: "call_old_quote",
      operationId: "op_wrong_purpose",
      carrierId: "car_exec",
      status: "COMPLETED",
      purpose: "QUOTE",
    });
    const service = createExecutionService({ database });
    assert.throws(
      () =>
        service.confirmPickup("op_wrong_purpose", {
          callId: "call_old_quote",
          occurredAt: t0,
          confirmedBy: "Juan",
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "CALL_PURPOSE_MISMATCH",
    );
    sqlite.close();
  });
});

class CapturingConferenceGateway implements HumanConferenceGateway {
  readonly inputs: JoinHumanConferenceInput[] = [];

  async joinHuman(input: JoinHumanConferenceInput) {
    this.inputs.push(input);
    return {
      conferenceSid: "CF_TEST",
      humanParticipantCallSid: "CA_HUMAN_TEST",
    };
  }
}

function seedOperation(
  database: BusinessFlowDatabase,
  input: {
    operationId: string;
    status: string;
    selectedCarrierId?: string | null;
  },
): void {
  database.insert(operations).values({
    id: input.operationId,
    customerName: "Textiles Pacífico",
    containerNumber: `CONT_${input.operationId}`,
    origin: "Manzanillo",
    destination: "Guadalajara",
    service: "DRAYAGE",
    status: input.status,
    selectedCarrierId: input.selectedCarrierId ?? null,
    createdAt: t0,
    updatedAt: t0,
  }).run();
}

function seedMandate(
  database: BusinessFlowDatabase,
  operationId: string,
  mandateId: string,
  maxTotalPriceCents: number,
  pickupDate: string,
): void {
  database.insert(mandates).values({
    id: mandateId,
    operationId,
    version: 1,
    status: "ACTIVE",
    maxTotalPriceCents,
    currency: "MXN",
    pickupDate,
    createdAt: t0,
  }).run();
}

function seedCall(
  database: BusinessFlowDatabase,
  input: {
    callId: string;
    operationId: string;
    carrierId?: string | null;
    status: string;
    purpose: string;
    twilioCallSid?: string | null;
  },
): void {
  database.insert(calls).values({
    id: input.callId,
    operationId: input.operationId,
    carrierId: input.carrierId ?? null,
    direction: "INBOUND",
    purpose: input.purpose,
    status: input.status,
    twilioCallSid: input.twilioCallSid ?? null,
    twilioStreamSid: null,
    recordingSid: null,
    recordingStatus: null,
    recordingUrl: null,
    recordingDurationSeconds: null,
    createdAt: t0,
  }).run();
}

function seedExecutionContext(
  database: BusinessFlowDatabase,
  input: {
    operationId: string;
    operationStatus: string;
    commitmentStatus: string;
  },
): void {
  database.insert(carriers).values({
    id: "car_exec",
    name: "Carrier Execution",
    dispatcherName: "Laura",
    phone: "+525555555501",
    score: 90,
    active: true,
    createdAt: t0,
  }).run();
  seedOperation(database, {
    operationId: input.operationId,
    status: input.operationStatus,
    selectedCarrierId: "car_exec",
  });
  seedMandate(database, input.operationId, "man_exec", 900_000, "2026-09-03");
  database.insert(campaigns).values({
    id: "cmp_exec",
    operationId: input.operationId,
    status: "COMPLETED",
    requestedCarriers: 3,
    maxParallelCalls: 3,
    strategy: "LOWEST_VALID_TOTAL",
    winningQuoteId: "quo_exec",
    createdAt: t0,
    completedAt: t0,
  }).run();
  database.insert(negotiations).values({
    id: "neg_exec",
    operationId: input.operationId,
    campaignId: "cmp_exec",
    carrierId: "car_exec",
    status: "SELECTED",
    createdAt: t0,
    updatedAt: t0,
  }).run();
  database.insert(quotes).values({
    id: "quo_exec",
    operationId: input.operationId,
    negotiationId: "neg_exec",
    carrierId: "car_exec",
    totalPriceCents: 850_000,
    currency: "MXN",
    pickupDate: "2026-09-03",
    valid: true,
    mandateId: "man_exec",
    validUntil: "2026-09-04T00:00:00.000Z",
    createdAt: t0,
  }).run();
  database.insert(commitments).values({
    id: "com_exec",
    operationId: input.operationId,
    quoteId: "quo_exec",
    carrierId: "car_exec",
    status: input.commitmentStatus,
    mandateId: "man_exec",
    totalPriceCents: 850_000,
    currency: "MXN",
    pickupDate: "2026-09-03",
    createdAt: t0,
    updatedAt: t0,
  }).run();
}
