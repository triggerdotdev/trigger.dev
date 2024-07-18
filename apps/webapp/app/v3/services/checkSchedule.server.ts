import { ZodError } from "zod";
import { CronPattern } from "../schedules";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { getLimit } from "~/services/platform.v3.server";
import { getTimezones } from "~/utils/timezones.server";
import { env } from "~/env.server";

type Schedule = {
  cron: string;
  timezone?: string;
  taskIdentifier: string;
  friendlyId?: string;
};

export class CheckScheduleService extends BaseService {
  public async call(projectId: string, schedule: Schedule) {
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

    //if creating a schedule, check they're under the limits
    if (!schedule.friendlyId) {
      //check they're within their limit
      const project = await this._prisma.project.findFirst({
        where: {
          id: projectId,
        },
        select: {
          organizationId: true,
        },
      });

      if (!project) {
        throw new ServiceValidationError("Project not found");
      }

      const limit = await getLimit(project.organizationId, "schedules", 500);
      const schedulesCount = await this._prisma.taskSchedule.count({
        where: {
          projectId,
        },
      });

      if (schedulesCount >= limit) {
        throw new ServiceValidationError(
          `You have created ${schedulesCount}/${limit} schedules so you'll need to increase your limits or delete some schedules. Increase your limits by contacting support.`
        );
      }
    }
  }
}
