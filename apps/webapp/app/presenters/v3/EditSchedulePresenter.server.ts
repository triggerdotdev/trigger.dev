import { type RuntimeEnvironmentType } from "@trigger.dev/database";
import { type PrismaClient, prisma } from "~/db.server";
import { displayableEnvironment, findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { filterOrphanedEnvironments } from "~/utils/environmentSort";
import { getTimezones } from "~/utils/timezones.server";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { formatScheduleWindow } from "~/v3/scheduleWindow.server";
import { resolveNewScheduleDefaultWindowSeconds } from "~/v3/scheduleDefaultWindow.server";
import {
  previewMinimumWindowForNewSchedule,
  resolveFreeSchedulePolicyContext,
  resolveMinimumWindowOnUpdate,
} from "~/v3/freeSchedulePolicy.server";

type EditScheduleOptions = {
  userId: string;
  projectSlug: string;
  environmentSlug: string;
  friendlyId?: string;
};

export type EditableScheduleElements = Awaited<ReturnType<EditSchedulePresenter["call"]>>;

type Environment = {
  id: string;
  type: RuntimeEnvironmentType;
  userName?: string;
};

export class EditSchedulePresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId, projectSlug, environmentSlug, friendlyId }: EditScheduleOptions) {
    // Find the project scoped to the organization
    const project = await this.#prismaClient.project.findFirstOrThrow({
      select: {
        id: true,
        organizationId: true,
        organization: { select: { featureFlags: true } },
        environments: {
          select: {
            id: true,
            type: true,
            slug: true,
            orgMember: {
              select: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    displayName: true,
                  },
                },
              },
            },
            branchName: true,
            parentEnvironmentId: true,
          },
        },
      },
      where: {
        slug: projectSlug,
        deletedAt: null,
        organization: {
          deletedAt: null,
          members: {
            some: {
              userId,
            },
          },
        },
      },
    });

    const environment = await findEnvironmentBySlug(
      project.id,
      environmentSlug,
      userId,
      this.#prismaClient
    );
    if (!environment) {
      throw new ServiceValidationError("No matching environment for project", 404);
    }

    //get the latest BackgroundWorker
    const latestWorker = await findCurrentWorkerFromEnvironment(environment, this.#prismaClient);

    //get all possible scheduled tasks
    const possibleTasks = latestWorker
      ? await this.#prismaClient.backgroundWorkerTask.findMany({
          where: {
            workerId: latestWorker.id,
            projectId: project.id,
            runtimeEnvironmentId: environment.id,
            triggerSource: "SCHEDULED",
          },
        })
      : [];

    const possibleEnvironments = filterOrphanedEnvironments(project.environments)
      // Exclude the branchable PREVIEW parent (it has no parent of its own);
      // only actual preview branches are schedulable.
      .filter(
        (environment) =>
          !(environment.type === "PREVIEW" && environment.parentEnvironmentId === null)
      )
      .map((environment) => {
        return {
          ...displayableEnvironment(environment, userId),
          branchName: environment.branchName ?? undefined,
        };
      });

    const newSchedulePolicy = friendlyId
      ? undefined
      : await this.#getNewSchedulePolicy(project.organizationId, project.organization.featureFlags);

    return {
      possibleTasks: possibleTasks.map((task) => task.slug).sort(),
      possibleEnvironments,
      possibleTimezones: getTimezones(),
      schedule: await this.#getExistingSchedule(
        friendlyId,
        project.id,
        possibleEnvironments,
        project.organizationId,
        project.organization.featureFlags
      ),
      newSchedulePolicy,
    };
  }

  async #getNewSchedulePolicy(organizationId: string, featureFlags: unknown) {
    const [defaultWindowDurationSeconds, freeSchedulePolicy] = await Promise.all([
      resolveNewScheduleDefaultWindowSeconds(this.#prismaClient, organizationId),
      resolveFreeSchedulePolicyContext(this.#prismaClient, { id: organizationId, featureFlags }),
    ]);

    return {
      defaultWindowDurationSeconds,
      minimumWindowDurationSeconds: previewMinimumWindowForNewSchedule(freeSchedulePolicy),
    };
  }

  async #getExistingSchedule(
    scheduleId: string | undefined,
    projectId: string,
    possibleEnvironments: Environment[],
    organizationId: string,
    featureFlags: unknown
  ) {
    if (!scheduleId) {
      return undefined;
    }

    const schedule = await this.#prismaClient.taskSchedule.findFirst({
      select: {
        id: true,
        type: true,
        friendlyId: true,
        generatorExpression: true,
        externalId: true,
        deduplicationKey: true,
        userProvidedDeduplicationKey: true,
        timezone: true,
        windowDurationSeconds: true,
        windowPercentage: true,
        defaultWindowDurationSeconds: true,
        minimumWindowDurationSeconds: true,
        taskIdentifier: true,
        instances: {
          select: {
            environmentId: true,
          },
        },
        active: true,
      },
      where: {
        friendlyId: scheduleId,
        projectId,
      },
    });

    if (!schedule) {
      throw new Response(null, { status: 404 });
    }

    const minimumWindowDurationSeconds =
      schedule.minimumWindowDurationSeconds === null
        ? null
        : resolveMinimumWindowOnUpdate(
            await resolveFreeSchedulePolicyContext(this.#prismaClient, {
              id: organizationId,
              featureFlags,
            }),
            schedule.minimumWindowDurationSeconds
          ).minimumWindowDurationSeconds;
    const { instances, ...scheduleFields } = schedule;

    return {
      ...scheduleFields,
      minimumWindowDurationSeconds,
      cron: schedule.generatorExpression,
      // The form shows only the user-configured value; a blank field lets a captured default
      // surface through the placeholder copy rather than appearing as a typed value.
      window: formatScheduleWindow(schedule),
      // Whether this schedule carries a captured default, so the form copy can say "clearing
      // returns to the 60-minute default" only for the new cohort, never for a grandfathered row.
      hasCapturedDefaultWindow: schedule.defaultWindowDurationSeconds !== null,
      environments: instances.flatMap((instance) => {
        const environment = possibleEnvironments.find((env) => env.id === instance.environmentId);
        if (!environment) {
          logger.error(
            `EditSchedulePresenter: environment with id ${instance.environmentId} not found`
          );
          return [];
        }

        return [environment];
      }),
    };
  }
}
