import { Prisma, TaskSchedule } from "@trigger.dev/database";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { BaseService } from "./baseService.server";
import { $transaction, PrismaClientOrTransaction } from "~/db.server";
import { nanoid } from "nanoid";
import { RegisterNextTaskScheduleInstanceService } from "./registerNextTaskScheduleInstance.server";
import { CreateSchedule, CronPattern } from "../schedules";

export type UpsertTaskScheduleServiceOptions = {
  projectId: string;
  userId: string;
  friendlyId: string;
};

export class DeleteTaskScheduleService extends BaseService {
  public async call({ projectId, userId, friendlyId }: UpsertTaskScheduleServiceOptions) {
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

    try {
      await this._prisma.taskSchedule.delete({
        where: {
          friendlyId,
        },
      });
    } catch (e) {
      throw new Error(
        `Error deleting schedule: ${e instanceof Error ? e.message : JSON.stringify(e)}`
      );
    }
  }
}
