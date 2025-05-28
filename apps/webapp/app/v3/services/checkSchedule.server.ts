import { ZodError } from "zod";
import { CronPattern } from "../schedules";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { getLimit } from "~/services/platform.v3.server";
import { getTimezones } from "~/utils/timezones.server";
import { env } from "~/env.server";
import { type PrismaClientOrTransaction, type RuntimeEnvironmentType } from "@trigger.dev/database";

type Schedule = {
  cron: string;
  timezone?: string;
  taskIdentifier: string;
  friendlyId?: string;
};

export class CheckScheduleService extends BaseService {
  public async call(projectId: string, schedule: Schedule, environmentIds: string[]) {
    //validate the cron expression
    try {
      CronPattern.parse(schedule.cron);
    } catch (e) {
      if (e instanceof ZodError) {
        throw new ServiceValidationError(`Invalid cron expression: ${e.issues[0].message}`);
      }

      throw new ServiceValidationError(
        `Invalid cron expression: ${e instanceof Error ? e.message : JSON.stringify(e)}`
      );
    }

    //chek it's a valid timezone
    if (schedule.timezone) {
      const possibleTimezones = getTimezones();
      if (!possibleTimezones.includes(schedule.timezone)) {
        throw new ServiceValidationError(
          `Invalid IANA timezone: '${schedule.timezone}'. View the list of valid timezones at ${env.APP_ORIGIN}/timezones`
        );
      }
    }

    //check the task exists
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
      throw new ServiceValidationError(
        `Task with identifier ${schedule.taskIdentifier} not found in project.`
      );
    }

    if (task.triggerSource !== "SCHEDULED") {
      throw new ServiceValidationError(
        `Task with identifier ${schedule.taskIdentifier} is not a scheduled task.`
      );
    }

    //check they're within their limit
    const project = await this._prisma.project.findFirst({
      where: {
        id: projectId,
      },
      select: {
        organizationId: true,
        environments: {
          select: {
            id: true,
            type: true,
            archivedAt: true,
          },
        },
      },
    });

    if (!project) {
      throw new ServiceValidationError("Project not found");
    }

    const environments = project.environments.filter((env) => environmentIds.includes(env.id));
    if (environments.some((env) => env.archivedAt)) {
      throw new ServiceValidationError("Can't add or edit a schedule for an archived branch");
    }

    //if creating a schedule, check they're under the limits
    if (!schedule.friendlyId) {
      const limit = await getLimit(project.organizationId, "schedules", 100_000_000);
      const schedulesCount = await CheckScheduleService.getUsedSchedulesCount({
        prisma: this._prisma,
        environments: project.environments,
      });

      if (schedulesCount >= limit) {
        throw new ServiceValidationError(
          `You have created ${schedulesCount}/${limit} schedules so you'll need to increase your limits or delete some schedules.`
        );
      }
    }
  }

  static async getUsedSchedulesCount({
    prisma,
    environments,
  }: {
    prisma: PrismaClientOrTransaction;
    environments: { id: string; type: RuntimeEnvironmentType }[];
  }) {
    const deployedEnvironments = environments.filter((env) => env.type !== "DEVELOPMENT");
    const schedulesCount = await prisma.taskScheduleInstance.count({
      where: {
        environmentId: {
          in: deployedEnvironments.map((env) => env.id),
        },
        active: true,
        taskSchedule: {
          active: true,
        },
      },
    });

    return schedulesCount;
  }
}
