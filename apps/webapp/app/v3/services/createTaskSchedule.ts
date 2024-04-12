import {
  RuntimeEnvironment,
  TaskRun,
  TaskSchedule,
  TaskScheduleInstance,
} from "@trigger.dev/database";
import { CreateSchedule } from "~/routes/_app.orgs.$organizationSlug.projects.v3.$projectParam.schedules.new/route";
import { BaseService } from "./baseService.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { Prisma } from "@trigger.dev/database";
import { parseExpression } from "cron-parser";

export type UpsertTaskScheduleServiceOptions = {
  projectId: string;
  userId: string;
  scheduleFriendlyId: string | undefined;
} & CreateSchedule;

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
  public async call(options: UpsertTaskScheduleServiceOptions) {
    const { projectId, userId, scheduleFriendlyId, ...schedule } = options;

    //first check that the user has access to the project
    const project = await this._prisma.project.findFirst({
      where: {
        id: projectId,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
    });

    if (!project) {
      throw new Error("User does not have access to the project");
    }

    //validate the cron expression
    try {
      parseExpression(schedule.cron);
    } catch (e) {
      throw new Error(`Invalid cron expression: ${e.message}`);
    }

    //get the existing schedule if there is one
    //either from a passed in friendlyId or from the deduplicationKey
    let existingSchedule: TaskSchedule | undefined = undefined;
    if (scheduleFriendlyId) {
      existingSchedule =
        (await this._prisma.taskSchedule.findFirst({
          where: {
            id: scheduleFriendlyId,
          },
        })) ?? undefined;
    } else if (schedule.deduplicationKey) {
      existingSchedule =
        (await this._prisma.taskSchedule.findFirst({
          where: {
            projectId,
            deduplicationKey: schedule.deduplicationKey,
          },
        })) ?? undefined;
    }

    //update
    if (existingSchedule) {
      //todo: update the schedule and instances
      return;
    }

    //create schedule
    const taskSchedule = await this._prisma.taskSchedule.create({
      data: {
        projectId,
        friendlyId: generateFriendlyId("schedule_"),
        taskIdentifier: schedule.taskIdentifier,
        deduplicationKey: schedule.deduplicationKey ? schedule.deduplicationKey : undefined,
        userProvidedDeduplicationKey: schedule.deduplicationKey !== undefined,
        cron: schedule.cron,
        externalId: schedule.externalId,
      },
    });

    //create the instances (links to environments)
    let instances: InstanceWithEnvironment[] = [];
    for (const environmentId of schedule.environments) {
      const instance = await this._prisma.taskScheduleInstance.create({
        data: {
          taskScheduleId: taskSchedule.id,
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

    return this.#createReturnObject(taskSchedule, instances);
  }

  #createReturnObject(taskSchedule: TaskSchedule, instances: InstanceWithEnvironment[]) {
    return {
      id: taskSchedule.friendlyId,
      task: taskSchedule.taskIdentifier,
      deduplicationKey: taskSchedule.userProvidedDeduplicationKey
        ? taskSchedule.deduplicationKey
        : undefined,
      cron: taskSchedule.cron,
      externalId: taskSchedule.externalId,
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
