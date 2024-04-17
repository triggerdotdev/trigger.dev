import { Prisma, TaskSchedule } from "@trigger.dev/database";
import { nanoid } from "nanoid";
import { ZodError } from "zod";
import { $transaction, PrismaClientOrTransaction } from "~/db.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { CronPattern, UpsertSchedule } from "../schedules";
import { BaseService } from "./baseService.server";
import { RegisterNextTaskScheduleInstanceService } from "./registerNextTaskScheduleInstance.server";
import cronstrue from "cronstrue";
import { calculateNextScheduledTimestamp } from "../utils/calculateNextSchedule.server";

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
    //validate the cron expression
    try {
      CronPattern.parse(schedule.cron);
    } catch (e) {
      if (e instanceof ZodError) {
        throw new Error(`Invalid cron expression: ${e.issues[0].message}`);
      }

      throw new Error(
        `Invalid cron expression: ${e instanceof Error ? e.message : JSON.stringify(e)}`
      );
    }

    const task = await this._prisma.backgroundWorkerTask.findFirst({
      where: {
        slug: schedule.taskIdentifier,
        projectId: projectId,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!task) {
      throw new Error(`Task with identifier ${schedule.taskIdentifier} not found in project.`);
    }

    if (task.triggerSource !== "SCHEDULED") {
      throw new Error(`Task with identifier ${schedule.taskIdentifier} is not a scheduled task.`);
    }

    const result = await $transaction(this._prisma, async (tx) => {
      const deduplicationKey =
        typeof schedule.deduplicationKey === "string" && schedule.deduplicationKey !== ""
          ? schedule.deduplicationKey
          : nanoid(24);

      const existingSchedule = schedule.friendlyId
        ? await tx.taskSchedule.findUnique({
            where: {
              friendlyId: schedule.friendlyId,
            },
          })
        : await tx.taskSchedule.findUnique({
            where: {
              projectId_deduplicationKey: {
                projectId,
                deduplicationKey,
              },
            },
          });

      if (existingSchedule) {
        return await this.#updateExistingSchedule(tx, existingSchedule, schedule, projectId);
      } else {
        return await this.#createNewSchedule(tx, schedule, projectId, deduplicationKey);
      }
    });

    if (!result) {
      throw new Error("Failed to create or update the schedule");
    }

    const { scheduleRecord, instances } = result;

    return this.#createReturnObject(scheduleRecord, instances);
  }

  async #createNewSchedule(
    tx: PrismaClientOrTransaction,
    options: UpsertTaskScheduleServiceOptions,
    projectId: string,
    deduplicationKey: string
  ) {
    const scheduleRecord = await tx.taskSchedule.create({
      data: {
        projectId,
        friendlyId: generateFriendlyId("sched"),
        taskIdentifier: options.taskIdentifier,
        deduplicationKey,
        userProvidedDeduplicationKey:
          options.deduplicationKey !== undefined && options.deduplicationKey !== "",
        generatorExpression: options.cron,
        generatorDescription: cronstrue.toString(options.cron),
        externalId: options.externalId,
      },
    });

    const registerNextService = new RegisterNextTaskScheduleInstanceService(tx);

    //create the instances (links to environments)
    let instances: InstanceWithEnvironment[] = [];
    for (const environmentId of options.environments) {
      const instance = await tx.taskScheduleInstance.create({
        data: {
          taskScheduleId: scheduleRecord.id,
          environmentId,
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

      await registerNextService.call(instance.id);

      instances.push(instance);
    }

    return { scheduleRecord, instances };
  }

  async #updateExistingSchedule(
    tx: PrismaClientOrTransaction,
    existingSchedule: TaskSchedule,
    options: UpsertTaskScheduleServiceOptions,
    projectId: string
  ) {
    //update the schedule
    const scheduleRecord = await tx.taskSchedule.update({
      where: {
        id: existingSchedule.id,
      },
      data: {
        generatorExpression: options.cron,
        generatorDescription: cronstrue.toString(options.cron),
        externalId: options.externalId,
      },
    });

    const scheduleHasChanged =
      scheduleRecord.generatorExpression !== existingSchedule.generatorExpression;

    // find the existing instances
    const existingInstances = await tx.taskScheduleInstance.findMany({
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

    // create the new instances
    let instances: InstanceWithEnvironment[] = [];

    for (const environmentId of options.environments) {
      const existingInstance = existingInstances.find((i) => i.environmentId === environmentId);

      if (existingInstance) {
        if (!existingInstance.active) {
          // If the instance is not active, we need to activate it
          await tx.taskScheduleInstance.update({
            where: {
              id: existingInstance.id,
            },
            data: {
              active: true,
            },
          });
        }

        // Update the existing instance
        instances.push({ ...existingInstance, active: true });
      } else {
        // Create a new instance
        const instance = await tx.taskScheduleInstance.create({
          data: {
            taskScheduleId: scheduleRecord.id,
            environmentId,
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

        instances.push(instance);
      }
    }

    // find the instances that need to be removed
    const instancesToDeactivate = existingInstances.filter(
      (i) => !options.environments.includes(i.environmentId)
    );

    // deactivate the instances
    for (const instance of instancesToDeactivate) {
      await tx.taskScheduleInstance.update({
        where: {
          id: instance.id,
        },
        data: {
          active: false,
        },
      });
    }

    if (scheduleHasChanged) {
      const registerService = new RegisterNextTaskScheduleInstanceService(tx);

      for (const instance of existingInstances) {
        await registerService.call(instance.id);
      }
    }

    return { scheduleRecord, instances };
  }

  #createReturnObject(taskSchedule: TaskSchedule, instances: InstanceWithEnvironment[]) {
    return {
      id: taskSchedule.friendlyId,
      task: taskSchedule.taskIdentifier,
      active: taskSchedule.active,
      externalId: taskSchedule.externalId,
      deduplicationKey: taskSchedule.userProvidedDeduplicationKey
        ? taskSchedule.deduplicationKey
        : undefined,
      cron: taskSchedule.generatorExpression,
      cronDescription: taskSchedule.generatorDescription,
      nextRun: calculateNextScheduledTimestamp(taskSchedule.generatorExpression),
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
