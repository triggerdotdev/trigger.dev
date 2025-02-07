import { BaseService } from "./baseService.server";

type Options = {
  projectId: string;
  userId: string;
  friendlyId: string;
};

export class DeleteTaskScheduleService extends BaseService {
  public async call({ projectId, userId, friendlyId }: Options) {
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
      const schedule = await this._prisma.taskSchedule.findFirst({
        where: {
          friendlyId,
        },
      });

      if (!schedule) {
        throw new Error("Schedule not found");
      }

      if (schedule.type === "DECLARATIVE") {
        throw new Error("Cannot delete declarative schedules");
      }

      await this._prisma.taskSchedule.delete({
        where: {
          id: schedule.id,
        },
      });
    } catch (e) {
      throw new Error(
        `Error deleting schedule: ${e instanceof Error ? e.message : JSON.stringify(e)}`
      );
    }
  }
}
