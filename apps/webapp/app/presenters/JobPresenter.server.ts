import { PrismaClient, prisma } from "~/db.server";
import { Job } from "~/models/job.server";

export class JobsListPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async getProjectJob(
    projectSlug: string,
    jobId: string
  ): Promise<Job | null> {
    return this.#prismaClient.job.findFirst({
      where: {
        projectId: projectSlug,
        id: jobId,
      },
    });
  }
}
