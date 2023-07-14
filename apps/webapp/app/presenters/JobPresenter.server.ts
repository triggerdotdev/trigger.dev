import { User } from "~/models/user.server";
import { PrismaClient, prisma } from "~/db.server";
import { Job } from "~/models/job.server";

export class JobsListPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    slug,
    userId,
  }: {
    slug: string;
    userId: string;
  }): Promise<Job[]> {
    return this.#prismaClient.job.findMany({
      where: {
        projectId: slug,
        id: userId,
      },
    });
  }
}
