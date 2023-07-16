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
  }: Pick<Job, "slug"> & { userId: User["id"] }) {
    const project = await this.#prismaClient.project.findFirst({
      where: {
        slug,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
      select: {
        jobs: {
          where: {
            internal: false,
          },
        },
      },
    });

    if (!project) {
      return undefined;
    }

    return project.jobs.filter((job) => !job.internal);
  }
}
