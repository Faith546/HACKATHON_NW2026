import { z } from "zod";
import { ApiError } from "../../shared/http/api-error";
import { CreateCampaignSchema } from "../campaigns/campaigns.types";
import {
  VerbalAgreementSchema,
} from "../commitments/commitments.types";
import { RequestEscalationSchema } from "../escalations/escalations.types";
import { ConfirmExecutionEventSchema } from "../execution/execution.types";
import {
  EvaluateChangeSchema,
  ReportIncidentSchema,
} from "../incidents/incidents.types";
import {
  EvaluateQuoteSchema,
  SaveQuoteSchema,
} from "../market/market.types";
import {
  CancelOperationSchema,
  CreateMandateInputSchema,
  CreateOperationSchema,
  currencyInputSchema,
} from "../operations/operations.types";
import type { VoiceToolName } from "./voice-core.port";

const identifier = z.string().trim().min(1);
const nonEmptyText = z.string().trim().min(1);
const emptyArguments = z.object({}).strict();
const operationReferenceArguments = z
  .object({
    operationId: identifier.optional(),
    containerNumber: identifier.optional(),
  })
  .strict();
const commitmentEvidenceArguments = z
  .object({
    startMs: z.number().int().nonnegative().optional(),
    endMs: z.number().int().positive().optional(),
    transcriptExcerpt: nonEmptyText,
  })
  .strict()
  .superRefine((input, context) => {
    if ((input.startMs === undefined) !== (input.endMs === undefined)) {
      context.addIssue({
        code: "custom",
        message: "startMs y endMs deben omitirse o enviarse juntos.",
        path: ["endMs"],
      });
    }
    if (
      input.startMs !== undefined &&
      input.endMs !== undefined &&
      input.startMs >= input.endMs
    ) {
      context.addIssue({
        code: "custom",
        message: "startMs debe ser menor que endMs.",
        path: ["endMs"],
      });
    }
  });

export const voiceToolSchemas = {
  createOperation: CreateOperationSchema.strict(),
  createMandate: CreateMandateInputSchema.strict(),
  getOperationStatus: operationReferenceArguments,
  listCarriers: emptyArguments,
  startCampaign: CreateCampaignSchema.strict(),
  getQuotes: emptyArguments,
  getCommitments: emptyArguments,
  cancelOperation: CancelOperationSchema.strict(),
  getActiveMandate: emptyArguments,
  evaluateOffer: EvaluateQuoteSchema.strict(),
  recordQuote: SaveQuoteSchema.omit({ callId: true }).strict(),
  reportNoAnswer: z.object({ reason: z.string().optional() }).strict(),
  getAuthorizedCommitment: emptyArguments,
  recordVerbalAgreement: VerbalAgreementSchema.omit({ callId: true }).strict(),
  attachCommitmentEvidence: commitmentEvidenceArguments,
  enqueueCommitmentSummary: z
    .object({ channel: z.literal("SMS").default("SMS") })
    .strict(),
  getOperation: emptyArguments,
  reportIncident: ReportIncidentSchema.omit({ callId: true }).strict(),
  evaluateIncidentChange: EvaluateChangeSchema.extend({
    incidentId: identifier,
  }).strict(),
  requestEscalation: RequestEscalationSchema.omit({
    callId: true,
    requestedHumanPhone: true,
  }).strict(),
  confirmPickup: ConfirmExecutionEventSchema.omit({ callId: true }).strict(),
  confirmDelivery: ConfirmExecutionEventSchema.omit({ callId: true }).strict(),
  saveCallBrief: z.object({
    summary: nonEmptyText,
    outcome: z.enum([
      "QUOTE_OBTAINED",
      "REFUSED",
      "NO_AGREEMENT",
      "COMMITTED",
      "INCIDENT_REPORTED",
      "ESCALATED",
      "COMPLETED",
    ]),
    mentions: z.array(z.string()),
    objections: z.array(z.string()).optional(),
    actions: z.array(z.string()),
    nextSteps: z.array(z.string()).optional(),
  }).strict(),
} satisfies Record<VoiceToolName, z.ZodType>;

const voiceMandateParametersSchema = CreateMandateInputSchema.extend({
  currency: currencyInputSchema,
}).strict();

export const voiceToolParameterSchemas = {
  ...voiceToolSchemas,
  createOperation: CreateOperationSchema.extend({
    mandate: voiceMandateParametersSchema,
  }).strict(),
  createMandate: voiceMandateParametersSchema,
  evaluateOffer: EvaluateQuoteSchema.extend({
    currency: currencyInputSchema,
  }).strict(),
  recordQuote: SaveQuoteSchema.omit({ callId: true, validUntil: true })
    .extend({ currency: currencyInputSchema })
    .strict(),
  recordVerbalAgreement: emptyArguments,
} satisfies Record<VoiceToolName, z.ZodType>;

export const voiceToolDescriptions: Record<VoiceToolName, string> = {
  createOperation: "Crea la operación y su mandato inicial con hechos confirmados por el operador.",
  createMandate: "Crea una nueva versión inmutable del mandato de la operación.",
  getOperationStatus: "Consulta el resumen operativo. En una llamada de operador sin contexto, resuelve de forma inequívoca por operationId o containerNumber.",
  listCarriers: "Lista los carriers disponibles para una campaña.",
  startCampaign: "Inicia una campaña con al menos tres carriers elegidos explícitamente.",
  getQuotes: "Lista las cotizaciones registradas para la operación.",
  getCommitments: "Lista el historial de commitments de la operación.",
  cancelOperation: "Cancela la operación con una razón explícita y auditable.",
  getActiveMandate: "Consulta el mandato vigente sin modificarlo.",
  evaluateOffer: "Evalúa una oferta contra el mandato activo sin persistirla.",
  recordQuote: "Registra la cotización final; el backend asigna automáticamente 24 horas de vigencia.",
  reportNoAnswer: "Marca la negociación actual como no contestada.",
  getAuthorizedCommitment: "Consulta el único commitment activo autorizado.",
  recordVerbalAgreement: "Registra la aceptación natural del carrier sobre el commitment autorizado; no requiere argumentos.",
  attachCommitmentEvidence: "Vincula el acuerdo al extracto literal del transcript; el runtime deriva offsets confiables.",
  enqueueCommitmentSummary: "Encola un recap canónico al contacto oficial del carrier y valida al aceptar el proveedor.",
  getOperation: "Consulta el estado oficial de la operación actual.",
  reportIncident: "Registra una incidencia reportada durante la llamada.",
  evaluateIncidentChange: "Evalúa el cambio propuesto contra el mandato activo.",
  requestEscalation: "Solicita que un humano se una a la llamada activa.",
  confirmPickup: "Confirma el pickup con evidencia de la llamada.",
  confirmDelivery: "Confirma la entrega con evidencia de la llamada.",
  saveCallBrief: "Guarda el resumen estructurado de la llamada actual.",
};

export function parseVoiceToolArguments(
  name: VoiceToolName,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const parsed = voiceToolSchemas[name].safeParse(value);
  if (!parsed.success) {
    throw new ApiError(
      422,
      "VOICE_TOOL_ARGUMENTS_INVALID",
      `Los argumentos de ${name} no cumplen su contrato.`,
      { issues: parsed.error.issues },
    );
  }
  return parsed.data as Record<string, unknown>;
}
