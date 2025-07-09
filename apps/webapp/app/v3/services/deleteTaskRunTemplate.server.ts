import { BaseService } from "./baseService.server";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";

export class DeleteTaskRunTemplateService extends BaseService {
  public async call(environment: AuthenticatedEnvironment, templateId: string) {
    try {
      await this._prisma.taskRunTemplate.delete({
        where: {
          id: templateId,
          projectId: environment.projectId,
        },
      });
    } catch (e) {
      throw new Error(
        `Error deleting template: ${e instanceof Error ? e.message : JSON.stringify(e)}`
      );
    }
  }
}
