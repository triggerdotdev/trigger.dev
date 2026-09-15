import { type Prisma, type TaskSchedule } from "@trigger.dev/database";
import cronstrue from "cronstrue";
import { nanoid } from "nanoid";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { type UpsertSchedule } from "../schedules";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { CheckScheduleService } from "./checkSchedule.server";
import { scheduleEngine } from "../scheduleEngine.server";
import {
  calculateNextScheduleRunTimes,
  formatResolvedScheduleWindow,
  normalizeScheduleWindow,
} from "../scheduleWindow.server";
import { resolveNewScheduleDefaultWindowSeconds } from "../scheduleDefaultWindow.server";
import { scheduleWhereClause } from "~/models/schedules.server";
import { env } from "~/env.server";
import {
  assertCronMeetsFreeMinimum,
  minimumWindowForNewSchedule,
  resolveFreeSchedulePolicyContext,
  resolveMinimumWindowOnUpdate,
  type FreeSchedulePolicyContext,
} from "../freeSchedulePolicy.server";

export type UpsertTaskScheduleServiceOptions = UpsertSchedule;

type InstanceWithEnvironment = Prisma.TaskScheduleInstanceGetPayload<{
  include: {
    environment: {
      include: {
        orgMember: {
          include: {
            user: true;
          };
        };
      };
    };
  };
}>;

export class UpsertTaskScheduleService extends BaseService {
  public async call(projectId: string, schedule: UpsertTaskScheduleServiceOptions) {
    //this throws errors if the schedule is invalid
    const checkSchedule = new CheckScheduleService(this._prisma);
    await checkSchedule.call(projectId, schedule, schedule.environments);

    const project = await this._prisma.project.findFirst({
      where: { id: projectId },
      select: {
        organizationId: true,
        organization: { select: { featureFlags: true } },
      },
    });

    if (!project) {
      throw new ServiceValidationError("Project not found");
    }

    const policy = await resolveFreeSchedulePolicyContext({
      id: project.organizationId,
      featureFlags: project.organization.featureFlags,
    });

    const deduplicationKey =
      typeof schedule.deduplicationKey === "string" && schedule.deduplicationKey !== ""
        ? schedule.deduplicationKey
        : nanoid(24);

    const existingSchedule = schedule.friendlyId
      ? await this._prisma.taskSchedule.findFirst({
          where: scheduleWhereClause(projectId, schedule.friendlyId),
        })
      : await this._prisma.taskSchedule.findFirst({
          where: {
            projectId,
            deduplicationKey,
          },
        });

    let result;
    if (existingSchedule) {
      if (existingSchedule.type === "DECLARATIVE") {
        throw new ServiceValidationError("Cannot update a declarative schedule");
      }
      result = await this.#updateExistingSchedule(existingSchedule, schedule, policy);
    } else {
      const defaultWindowDurationSeconds = await resolveNewScheduleDefaultWindowSeconds(
        this._prisma,
        project.organizationId
      );
      result = await this.#createNewSchedule(
        schedule,
        projectId,
        deduplicationKey,
        policy,
        defaultWindowDurationSeconds
      );
    }

    if (!result) {
      throw new ServiceValidationError("Failed to create or update schedule");
    }

    const { scheduleRecord } = result;

    const instances = await this._prisma.taskScheduleInstance.findMany({
      where: {
        taskScheduleId: scheduleRecord.id,
      },
      include: {
        environment: {
          include: {
            orgMember: {
              include: {
                user: true,
              },
            },
          },
        },
      },
    });

    return this.#createReturnObject(scheduleRecord, instances, schedule.environments[0]);
  }

  async #createNewSchedule(
    options: UpsertTaskScheduleServiceOptions,
    projectId: string,
    deduplicationKey: string,
    policy: FreeSchedulePolicyContext,
    defaultWindowDurationSeconds: number | null
  ) {
    const minimumWindowDurationSeconds = minimumWindowForNewSchedule(policy, "IMPERATIVE");

    if (minimumWindowDurationSeconds !== null) {
      assertCronMeetsFreeMinimum({
        cron: options.cron,
        timezone: options.timezone,
        minimumWindowDurationSeconds,
        scheduleType: "IMPERATIVE",
      });
    }

    const scheduleRecord = await this._prisma.taskSchedule.create({
      data: {
        projectId,
        friendlyId: generateFriendlyId("sched"),
        taskIdentifier: options.taskIdentifier,
        deduplicationKey,
        userProvidedDeduplicationKey:
          options.deduplicationKey !== undefined && options.deduplicationKey !== "",
        generatorExpression: options.cron,
        generatorDescription: cronstrue.toString(options.cron),
        timezone: options.timezone ?? "UTC",
        externalId: options.externalId ? options.externalId : undefined,
        minimumWindowDurationSeconds,
        ...normalizeScheduleWindow(options.window),
        defaultWindowDurationSeconds,
      },
    });

    //create the instances (links to environments)
    for (const environmentId of options.environments) {
      const instance = await this._prisma.taskScheduleInstance.create({
        data: {
          taskScheduleId: scheduleRecord.id,
          environmentId,
          projectId,
        },
        include: {
          environment: {
            include: {
              orgMember: {
                include: {
                  user: true,
                },
              },
            },
          },
        },
      });

      await scheduleEngine.registerNextTaskScheduleInstance({ instanceId: instance.id });
    }

    return { scheduleRecord };
  }

  async #updateExistingSchedule(
    existingSchedule: TaskSchedule,
    options: UpsertTaskScheduleServiceOptions,
    policy: FreeSchedulePolicyContext
  ) {
    const minimumResolution = resolveMinimumWindowOnUpdate(
      policy,
      existingSchedule.minimumWindowDurationSeconds
    );

    if (minimumResolution.enforce && minimumResolution.minimumWindowDurationSeconds !== null) {
      assertCronMeetsFreeMinimum({
        cron: options.cron,
        timezone: options.timezone,
        minimumWindowDurationSeconds: minimumResolution.minimumWindowDurationSeconds,
        scheduleType: "IMPERATIVE",
      });
    }

    // find the existing instances
    const existingInstances = await this._prisma.taskScheduleInstance.findMany({
      where: {
        taskScheduleId: existingSchedule.id,
      },
      include: {
        environment: {
          include: {
            orgMember: {
              include: {
                user: true,
              },
            },
          },
        },
      },
    });

    const scheduleRecord = await this._prisma.taskSchedule.update({
      where: {
        id: existingSchedule.id,
      },
      data: {
        generatorExpression: options.cron,
        generatorDescription: cronstrue.toString(options.cron),
        timezone: options.timezone ?? "UTC",
        externalId: options.externalId ? options.externalId : null,
        minimumWindowDurationSeconds: minimumResolution.minimumWindowDurationSeconds,
        ...normalizeScheduleWindow(options.window),
      },
    });

    // Updates preserve the captured default; omitting the explicit window falls back to it.
    const scheduleHasChanged =
      scheduleRecord.generatorExpression !== existingSchedule.generatorExpression ||
      scheduleRecord.timezone !== existingSchedule.timezone ||
      scheduleRecord.windowDurationSeconds !== existingSchedule.windowDurationSeconds ||
      scheduleRecord.windowPercentage !== existingSchedule.windowPercentage ||
      // Clearing the minimum changes the effective range.
      scheduleRecord.minimumWindowDurationSeconds !== existingSchedule.minimumWindowDurationSeconds;

    // create the new instances
    const newInstances: InstanceWithEnvironment[] = [];
    const updatingInstances: InstanceWithEnvironment[] = [];

    for (const environmentId of options.environments) {
      const existingInstance = existingInstances.find((i) => i.environmentId === environmentId);

      if (existingInstance) {
        // Update the existing instance
        updatingInstances.push(existingInstance);
      } else {
        // Create a new instance
        const instance = await this._prisma.taskScheduleInstance.create({
          data: {
            taskScheduleId: scheduleRecord.id,
            environmentId,
            projectId: existingSchedule.projectId,
          },
          include: {
            environment: {
              include: {
                orgMember: {
                  include: {
                    user: true,
                  },
                },
              },
            },
          },
        });

        newInstances.push(instance);
      }
    }

    // find the instances that need to be removed
    const instancesToDeleted = existingInstances.filter(
      (i) => !options.environments.includes(i.environmentId)
    );

    // delete the instances no longer selected
    for (const instance of instancesToDeleted) {
      await this._prisma.taskScheduleInstance.delete({
        where: {
          id: instance.id,
        },
      });
    }

    for (const instance of newInstances) {
      // Register the new task schedule instances
      await scheduleEngine.registerNextTaskScheduleInstance({ instanceId: instance.id });
    }

    if (scheduleHasChanged) {
      for (const instance of updatingInstances) {
        // Update the existing task schedule instances
        await scheduleEngine.registerNextTaskScheduleInstance({ instanceId: instance.id });
      }
    }

    return { scheduleRecord };
  }

  #createReturnObject(
    taskSchedule: TaskSchedule,
    instances: InstanceWithEnvironment[],
    environmentId: string
  ) {
    const instance = instances.find((instance) => instance.environmentId === environmentId);
    if (!instance) {
      throw new ServiceValidationError("Failed to find the schedule instance");
    }

    const [nextRun] = calculateNextScheduleRunTimes({
      cron: taskSchedule.generatorExpression,
      timezone: taskSchedule.timezone,
      deduplicationKey: taskSchedule.deduplicationKey,
      environmentId: instance.environmentId,
      schedulePhase: instance.schedulePhase,
      phaseSecret: env.ENCRYPTION_KEY,
      windowDurationSeconds: taskSchedule.windowDurationSeconds,
      windowPercentage: taskSchedule.windowPercentage,
      defaultWindowDurationSeconds: taskSchedule.defaultWindowDurationSeconds,
      minimumWindowDurationSeconds: taskSchedule.minimumWindowDurationSeconds,
    });

    return {
      id: taskSchedule.friendlyId,
      type: taskSchedule.type,
      task: taskSchedule.taskIdentifier,
      active: taskSchedule.active,
      externalId: taskSchedule.externalId,
      deduplicationKey: taskSchedule.userProvidedDeduplicationKey
        ? taskSchedule.deduplicationKey
        : undefined,
      cron: taskSchedule.generatorExpression,
      cronDescription: taskSchedule.generatorDescription,
      timezone: taskSchedule.timezone,
      window: formatResolvedScheduleWindow(taskSchedule).window,
      nextRun: nextRun.nominalAt,
      nextRunEffectiveAt: nextRun.effectiveAt,
      appliedSchedulePolicy:
        taskSchedule.minimumWindowDurationSeconds !== null
          ? {
              minimumWindowSeconds: taskSchedule.minimumWindowDurationSeconds,
              reason: "free_schedule" as const,
            }
          : undefined,
      environments: instances.map((instance) => ({
        id: instance.environment.id,
        shortcode: instance.environment.shortcode,
        type: instance.environment.type,
        userName:
          instance.environment.orgMember?.user.displayName ??
          instance.environment.orgMember?.user.name ??
          undefined,
      })),
    };
  }
}
