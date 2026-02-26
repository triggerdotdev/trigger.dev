import { type CustomerQueryScope } from "@trigger.dev/database";
import { z } from "zod";
import { type PrismaClientOrTransaction } from "~/db.server";
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
import { BaseService, ServiceValidationError } from "../baseService.server";
import { EvaluateAlertDefinitionService, AlertConditionsSchema } from "./evaluateAlertDefinition.server";

/** Minimum allowed evaluation interval in seconds */
const MIN_INTERVAL_SECONDS = 60;

export const CreateAlertV2DefinitionInput = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  query: z.string().min(1),
  scope: z.enum(["ORGANIZATION", "PROJECT", "ENVIRONMENT"]),
  queryPeriod: z.string().default("1h"),
  conditions: AlertConditionsSchema,
  evaluationIntervalSeconds: z.number().int().min(MIN_INTERVAL_SECONDS).default(300),
  alertChannelIds: z.array(z.string()).default([]),
  organizationId: z.string(),
  projectId: z.string().optional(),
  environmentId: z.string().optional(),
  createdById: z.string().optional(),
});

export type CreateAlertV2DefinitionInput = z.infer<typeof CreateAlertV2DefinitionInput>;

export class CreateAlertV2DefinitionService extends BaseService {
  public async call(input: CreateAlertV2DefinitionInput) {
    const parsed = CreateAlertV2DefinitionInput.safeParse(input);
    if (!parsed.success) {
      throw new ServiceValidationError(parsed.error.issues[0].message);
    }

    const data = parsed.data;

    // Validate scope consistency
    if (data.scope === "PROJECT" && !data.projectId) {
      throw new ServiceValidationError("projectId is required for PROJECT scope");
    }
    if (data.scope === "ENVIRONMENT" && (!data.projectId || !data.environmentId)) {
      throw new ServiceValidationError(
        "projectId and environmentId are required for ENVIRONMENT scope"
      );
    }

    const definition = await this._prisma.alertV2Definition.create({
      data: {
        friendlyId: generateFriendlyId("alrtv2"),
        name: data.name,
        description: data.description,
        query: data.query,
        scope: data.scope as CustomerQueryScope,
        queryPeriod: data.queryPeriod,
        conditions: data.conditions,
        evaluationIntervalSeconds: data.evaluationIntervalSeconds,
        alertChannelIds: data.alertChannelIds,
        enabled: true,
        organizationId: data.organizationId,
        projectId: data.projectId,
        environmentId: data.environmentId,
        createdById: data.createdById,
      },
    });

    // Enqueue the first evaluation immediately; subsequent runs are self-scheduled
    await EvaluateAlertDefinitionService.enqueue(definition.id);

    return definition;
  }

  /** Re-enable a disabled alert and restart its evaluation chain */
  static async enable(
    alertDefinitionId: string,
    prisma: PrismaClientOrTransaction
  ) {
    const definition = await prisma.alertV2Definition.update({
      where: { id: alertDefinitionId },
      data: { enabled: true },
    });

    // Restart the self-scheduling chain
    await EvaluateAlertDefinitionService.enqueue(definition.id);

    return definition;
  }

  /** Disable an alert — the evaluation chain will terminate after the current run */
  static async disable(alertDefinitionId: string, prisma: PrismaClientOrTransaction) {
    return prisma.alertV2Definition.update({
      where: { id: alertDefinitionId },
      data: { enabled: false },
    });
  }
}
