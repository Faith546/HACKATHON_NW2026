import { db } from "../../db";
import {
  IncidentsRepository,
  type IncidentRecord,
  type IncidentsDatabase,
  type IncidentsRepositoryOptions,
} from "./incidents.repository";
import type {
  EvaluateChangeInput,
  EvaluationResult,
  ReportIncidentInput,
} from "./incidents.types";

export class IncidentsService {
  constructor(private readonly repository: IncidentsRepository) {}

  reportIncident(
    operationId: string,
    input: ReportIncidentInput,
    actorId?: string,
  ): IncidentRecord {
    return this.repository.reportIncident(operationId, input, actorId);
  }

  evaluateChange(
    incidentId: string,
    input: EvaluateChangeInput,
    actorId?: string,
  ): EvaluationResult {
    return this.repository.evaluateChange(incidentId, input, actorId);
  }

  getIncident(incidentId: string): IncidentRecord | null {
    return this.repository.findById(incidentId);
  }
}

export interface CreateIncidentsServiceOptions
  extends IncidentsRepositoryOptions {
  database?: IncidentsDatabase;
}

export function createIncidentsService(
  options: CreateIncidentsServiceOptions = {},
): IncidentsService {
  const { database = db, ...repositoryOptions } = options;
  return new IncidentsService(
    new IncidentsRepository(database, repositoryOptions),
  );
}

export const incidentsService = createIncidentsService();
