import { type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { BackgroundWorkerMetadata, type GetDeploymentResponseBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { boundedIn, prisma } from "~/db.server";
import { authenticateApiKeyWithScope } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { env } from "~/env.server";
import { calculateNextScheduleRunTimes, normalizeScheduleWindow } from "~/v3/scheduleWindow.server";
import { nextScheduledTimestamps } from "~/v3/utils/calculateNextSchedule.server";

const ParamsSchema = z.object({
  deploymentId: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  try {
    // Next authenticate the request
    const authResult = await authenticateApiKeyWithScope(request, {
      action: "read",
      resource: { type: "deployments" },
    });

    if (!authResult.ok) {
      logger.info("Invalid or missing api key", { url: request.url });
      return json({ error: authResult.error }, { status: authResult.status });
    }

    const authenticationResult = authResult.authentication;

    const authenticatedEnv = authenticationResult.environment;

    const { deploymentId } = parsedParams.data;

    const deployment = await prisma.workerDeployment.findFirst({
      where: {
        friendlyId: deploymentId,
        environmentId: authenticatedEnv.id,
      },
      include: {
        worker: {
          include: {
            tasks: true,
          },
        },
        integrationDeployments: true,
      },
    });

    if (!deployment) {
      return json({ error: "Deployment not found" }, { status: 404 });
    }

    const workerMetadata = deployment.worker
      ? BackgroundWorkerMetadata.safeParse(deployment.worker.metadata)
      : undefined;
    const declarativeTasks = workerMetadata?.success
      ? workerMetadata.data.tasks.flatMap((task) => {
          const schedule = task.schedule;
          if (
            !schedule ||
            (schedule.environments && !schedule.environments.includes(authenticatedEnv.type))
          ) {
            return [];
          }

          return [{ id: task.id, schedule }];
        })
      : [];
    const persistedDeclarativeSchedules =
      declarativeTasks.length > 0
        ? await prisma.taskSchedule.findMany({
            where: {
              type: "DECLARATIVE",
              projectId: authenticatedEnv.projectId,
              taskIdentifier: { in: boundedIn(declarativeTasks.map((task) => task.id)) },
              instances: { some: { environmentId: authenticatedEnv.id } },
            },
            select: {
              taskIdentifier: true,
              deduplicationKey: true,
              generatorExpression: true,
              timezone: true,
              windowDurationSeconds: true,
              windowPercentage: true,
              instances: {
                where: { environmentId: authenticatedEnv.id },
                select: { schedulePhase: true },
              },
            },
          })
        : [];
    const declarativeSchedules = declarativeTasks.map((task) => {
      const windowFields = normalizeScheduleWindow(task.schedule.window);
      const persistedSchedule = persistedDeclarativeSchedules.find(
        (schedule) =>
          schedule.taskIdentifier === task.id &&
          schedule.generatorExpression === task.schedule.cron &&
          schedule.timezone === task.schedule.timezone &&
          schedule.windowDurationSeconds === windowFields.windowDurationSeconds &&
          schedule.windowPercentage === windowFields.windowPercentage
      );
      const registeredNextRun = persistedSchedule
        ? calculateNextScheduleRunTimes({
            cron: task.schedule.cron,
            timezone: task.schedule.timezone,
            deduplicationKey: persistedSchedule.deduplicationKey,
            environmentId: authenticatedEnv.id,
            schedulePhase: persistedSchedule.instances[0]?.schedulePhase ?? null,
            phaseSecret: env.ENCRYPTION_KEY,
            ...windowFields,
          })[0]
        : undefined;

      return {
        task: task.id,
        cron: task.schedule.cron,
        timezone: task.schedule.timezone,
        window: task.schedule.window,
        nextRun:
          registeredNextRun?.nominalAt ??
          nextScheduledTimestamps(task.schedule.cron, task.schedule.timezone, new Date())[0],
        nextRunEffectiveAt: registeredNextRun?.effectiveAt ?? null,
      };
    });

    return json({
      id: deployment.friendlyId,
      status: deployment.status,
      contentHash: deployment.contentHash,
      shortCode: deployment.shortCode,
      version: deployment.version,
      imageReference: deployment.imageReference,
      imagePlatform: deployment.imagePlatform,
      commitSHA: deployment.commitSHA,
      externalBuildData:
        deployment.externalBuildData as GetDeploymentResponseBody["externalBuildData"],
      errorData: deployment.errorData as GetDeploymentResponseBody["errorData"],
      worker: deployment.worker
        ? {
            id: deployment.worker.friendlyId,
            version: deployment.worker.version,
            tasks: deployment.worker.tasks.map((task) => ({
              id: task.friendlyId,
              slug: task.slug,
              filePath: task.filePath,
              exportName: task.exportName ?? "@deprecated",
            })),
            declarativeSchedules,
          }
        : undefined,
      integrationDeployments:
        deployment.integrationDeployments.length > 0
          ? deployment.integrationDeployments.map((id) => ({
              id: id.id,
              integrationName: id.integrationName,
              integrationDeploymentId: id.integrationDeploymentId,
              commitSHA: id.commitSHA,
              createdAt: id.createdAt,
            }))
          : undefined,
    } satisfies GetDeploymentResponseBody);
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to load deployment", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
