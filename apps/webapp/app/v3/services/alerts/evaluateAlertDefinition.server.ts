import { type AlertV2State } from "@trigger.dev/database";
import { z } from "zod";
import { executeTSQL, type FieldMappings, type WhereClauseCondition } from "@internal/clickhouse";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { clickhouseClient, queryClickhouseClient } from "~/services/clickhouseInstance.server";
import { logger } from "~/services/logger.server";
import { alertsWorker } from "~/v3/alertsWorker.server";
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
import { querySchemas } from "~/v3/querySchemas";
import { BaseService } from "../baseService.server";
import { DeliverAlertService } from "./deliverAlert.server";
import parse from "parse-duration";

/** A single condition in an alert definition */
const AlertConditionSchema = z.object({
  /** Column name from the query result to evaluate */
  field: z.string(),
  /** Comparison operator */
  op: z.enum(["gt", "gte", "lt", "lte", "eq", "neq"]),
  /** Threshold value */
  value: z.number(),
});

export type AlertCondition = z.infer<typeof AlertConditionSchema>;
export const AlertConditionsSchema = z.array(AlertConditionSchema);

/** Evaluates a single AlertV2Definition and writes results to ClickHouse */
export class EvaluateAlertDefinitionService extends BaseService {
  public async call(alertDefinitionId: string) {
    const definition = await this._prisma.alertV2Definition.findUnique({
      where: { id: alertDefinitionId },
      include: {
        organization: { select: { id: true } },
        project: { select: { id: true, externalRef: true } },
        environment: { select: { id: true, slug: true } },
      },
    });

    if (!definition) {
      logger.warn("[EvaluateAlertDefinition] Definition not found", { alertDefinitionId });
      return;
    }

    if (!definition.enabled) {
      logger.debug("[EvaluateAlertDefinition] Definition is disabled, skipping", {
        alertDefinitionId,
      });
      return;
    }

    const startTime = Date.now();
    let errorMessage = "";
    let queryValue: number | null = null;
    let newState: AlertV2State = definition.state;

    // Parse conditions JSON
    const conditionsResult = AlertConditionsSchema.safeParse(definition.conditions);
    if (!conditionsResult.success) {
      logger.error("[EvaluateAlertDefinition] Invalid conditions JSON", {
        alertDefinitionId,
        conditions: definition.conditions,
        error: conditionsResult.error.message,
      });
      return;
    }
    const conditions = conditionsResult.data;

    try {
      // Build tenant isolation constraints
      const scope = definition.scope;
      const organizationId = definition.organizationId;
      const projectId = definition.project?.id ?? "";
      const environmentId = definition.environment?.id ?? "";

      // Find the time column for this query (same logic as executeQuery)
      const matchedSchema = querySchemas.find((s) =>
        new RegExp(`\\bFROM\\s+${s.name}\\b`, "i").test(definition.query)
      );
      const timeColumn = matchedSchema?.timeConstraint ?? "triggered_at";

      // Convert queryPeriod string (e.g. "1h", "5m", "24h") to a from Date
      const periodMs = parse(definition.queryPeriod) ?? 60 * 60 * 1000; // default 1h
      const fromDate = new Date(Date.now() - periodMs);
      const timeFallback: WhereClauseCondition = { op: "gte", value: fromDate };

      // Enforce tenant isolation - always include organization_id
      const enforcedWhereClause: Record<string, WhereClauseCondition | undefined> = {
        organization_id: { op: "eq", value: organizationId },
        project_id:
          scope === "PROJECT" || scope === "ENVIRONMENT"
            ? { op: "eq", value: projectId }
            : undefined,
        environment_id: scope === "ENVIRONMENT" ? { op: "eq", value: environmentId } : undefined,
        [timeColumn]: { op: "gte", value: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) }, // Absolute max lookback safety limit
      };

      // Build field mappings for project_ref and environment slug translation
      const projects = await prisma.project.findMany({
        where: { organizationId },
        select: { id: true, externalRef: true },
      });
      const environments = await prisma.runtimeEnvironment.findMany({
        where: { project: { organizationId } },
        select: { id: true, slug: true },
      });

      const fieldMappings: FieldMappings = {
        project: Object.fromEntries(projects.map((p) => [p.id, p.externalRef])),
        environment: Object.fromEntries(environments.map((e) => [e.id, e.slug])),
      };

      // Execute the TSQL query against ClickHouse
      const result = await executeTSQL(queryClickhouseClient.reader, {
        query: definition.query,
        schema: z.record(z.unknown()),
        tableSchema: querySchemas,
        enforcedWhereClause,
        fieldMappings,
        whereClauseFallback: {
          [timeColumn]: timeFallback,
        },
        clickhouseSettings: {
          max_execution_time: env.QUERY_CLICKHOUSE_MAX_EXECUTION_TIME,
          timeout_overflow_mode: "throw",
          max_memory_usage: String(env.QUERY_CLICKHOUSE_MAX_MEMORY_USAGE),
          max_ast_elements: String(env.QUERY_CLICKHOUSE_MAX_AST_ELEMENTS),
          max_expanded_ast_elements: String(env.QUERY_CLICKHOUSE_MAX_EXPANDED_AST_ELEMENTS),
          readonly: "1",
          format_csv_allow_double_quotes: 0,
        },
        querySettings: {
          maxRows: 1000,
        },
      });

      if (result[0] !== null) {
        // Query error
        errorMessage = result[0].message ?? "Query execution failed";
        logger.warn("[EvaluateAlertDefinition] Query failed", {
          alertDefinitionId,
          error: errorMessage,
        });
      } else {
        const rows = result[1]?.data ?? [];

        // Extract numeric value from first row for display purposes
        if (rows.length > 0) {
          const firstRow = rows[0];
          for (const val of Object.values(firstRow)) {
            const num = Number(val);
            if (!isNaN(num) && val !== null && val !== "") {
              queryValue = num;
              break;
            }
          }
        }

        // Evaluate all conditions (ALL must pass for alert to fire)
        const allConditionsMet =
          conditions.length > 0 &&
          conditions.every((condition) => {
            // For empty result sets: treat all fields as 0
            const rawValue = rows.length > 0 ? rows[0][condition.field] : null;
            const fieldValue = rawValue !== null && rawValue !== undefined ? Number(rawValue) : 0;
            return evaluateCondition(fieldValue, condition.op, condition.value);
          });

        newState = allConditionsMet ? "FIRING" : "OK";
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("[EvaluateAlertDefinition] Unexpected error during evaluation", {
        alertDefinitionId,
        error: errorMessage,
      });
    }

    const queryDurationMs = Date.now() - startTime;
    const stateChanged = newState !== definition.state;
    const evaluatedAt = new Date();

    // Write evaluation result to ClickHouse
    const [insertError] = await clickhouseClient.alertEvaluations.insert([
      {
        alert_definition_id: definition.id,
        organization_id: definition.organizationId,
        project_id: definition.project?.id ?? "",
        environment_id: definition.environment?.id ?? "",
        evaluated_at: evaluatedAt.toISOString(),
        state: newState === "FIRING" ? "firing" : "ok",
        state_changed: stateChanged ? 1 : 0,
        value: queryValue,
        conditions: JSON.stringify(conditionsResult.success ? conditionsResult.data : []),
        query_duration_ms: queryDurationMs,
        error_message: errorMessage,
      },
    ]);

    if (insertError) {
      logger.error("[EvaluateAlertDefinition] Failed to write evaluation to ClickHouse", {
        alertDefinitionId,
        error: insertError,
      });
    }

    // Update the definition's state, lastEvaluatedAt (and lastStateChangedAt if changed)
    await this._prisma.alertV2Definition.update({
      where: { id: definition.id },
      data: {
        state: newState,
        lastEvaluatedAt: evaluatedAt,
        ...(stateChanged ? { lastStateChangedAt: evaluatedAt } : {}),
      },
    });

    // If state changed, create alert notifications
    if (stateChanged && definition.alertChannelIds.length > 0) {
      await this.#notifyChannels(definition, newState, evaluatedAt);
    }

    logger.debug("[EvaluateAlertDefinition] Evaluation complete", {
      alertDefinitionId,
      previousState: definition.state,
      newState,
      stateChanged,
      queryValue,
      queryDurationMs,
    });
  }

  async #notifyChannels(
    definition: {
      id: string;
      alertChannelIds: string[];
      organizationId: string;
      projectId: string | null;
      environmentId: string | null;
    },
    newState: AlertV2State,
    evaluatedAt: Date
  ) {
    const alertType = newState === "FIRING" ? "ALERT_V2_FIRING" : "ALERT_V2_RESOLVED";

    const channels = await this._prisma.projectAlertChannel.findMany({
      where: { id: { in: definition.alertChannelIds }, enabled: true },
      select: { id: true, type: true, projectId: true },
    });

    // We need a projectId and environmentId for the ProjectAlert record.
    // Use the definition's project/env or fall back to the first channel's project.
    const projectId = definition.projectId ?? channels[0]?.projectId;
    if (!projectId) {
      logger.warn("[EvaluateAlertDefinition] No projectId available for notification", {
        alertDefinitionId: definition.id,
      });
      return;
    }

    // Find an environment for the alert record (required by ProjectAlert)
    const environment = await this._prisma.runtimeEnvironment.findFirst({
      where: definition.environmentId
        ? { id: definition.environmentId }
        : { projectId, type: { not: "DEVELOPMENT" } },
      select: { id: true },
    });

    if (!environment) {
      logger.warn("[EvaluateAlertDefinition] No environment found for notification", {
        alertDefinitionId: definition.id,
        projectId,
      });
      return;
    }

    for (const channel of channels) {
      await this._prisma.projectAlert
        .create({
          data: {
            friendlyId: generateFriendlyId("alert"),
            channelId: channel.id,
            projectId,
            environmentId: environment.id,
            status: "PENDING",
            type: alertType,
            alertV2DefinitionId: definition.id,
          },
        })
        .then((alert) => DeliverAlertService.enqueue(alert.id))
        .catch((error) => {
          logger.error("[EvaluateAlertDefinition] Failed to create/enqueue alert", {
            alertDefinitionId: definition.id,
            channelId: channel.id,
            error,
          });
        });
    }
  }

  static async enqueue(alertDefinitionId: string, runAt?: Date) {
    return await alertsWorker.enqueue({
      id: `evaluateAlertDefinition:${alertDefinitionId}`,
      job: "v3.evaluateAlertDefinition",
      payload: { alertDefinitionId },
      availableAt: runAt,
    });
  }
}

function evaluateCondition(
  fieldValue: number,
  op: AlertCondition["op"],
  threshold: number
): boolean {
  switch (op) {
    case "gt":
      return fieldValue > threshold;
    case "gte":
      return fieldValue >= threshold;
    case "lt":
      return fieldValue < threshold;
    case "lte":
      return fieldValue <= threshold;
    case "eq":
      return fieldValue === threshold;
    case "neq":
      return fieldValue !== threshold;
  }
}
