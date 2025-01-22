import { PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { getCurrentProjectId } from "~/services/currentProject.server";

export class SelectBestProjectPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId, request }: { userId: string; request: Request }) {
    //try get current project from cookie
    const projectId = await getCurrentProjectId(request);
    if (projectId) {
      const project = await this.#prismaClient.project.findUnique({
        where: { id: projectId, deletedAt: null, organization: { members: { some: { userId } } } },
        include: { organization: true },
      });
      if (project) {
        return { project, organization: project.organization };
      }
    }

    //failing that, we pick the most recently modified project
    const projects = await this.#prismaClient.project.findMany({
      include: {
        organization: true,
      },
      where: {
        deletedAt: null,
        organization: {
          members: { some: { userId } },
        },
      },
      orderBy: {
        updatedAt: "desc",
      },
      take: 1,
    });

    if (projects.length === 0) {
      throw new Response("Not Found", { status: 404 });
    }

    return { project: projects[0], organization: projects[0].organization };
  }
}
