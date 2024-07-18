import { BaseService } from "./baseService.server";

type Options = {
  projectId: string;
  userId: string;
  friendlyId: string;
  active: boolean;
};

export class SetActiveOnTaskScheduleService extends BaseService {
  public async call({ projectId, userId, friendlyId, active }: Options) {
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
        throw new Error("Cannot enable/disable declarative schedules");
      }

      await this._prisma.taskSchedule.update({
        where: {
          friendlyId,
        },
        data: {
          active,
        },
      });
    } catch (e) {
      throw new Error(
        `Error ${active ? "enabling" : "disabling"} schedule: ${
          e instanceof Error ? e.message : JSON.stringify(e)
        }`
      );
    }
  }
}
