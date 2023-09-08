import { TriggerSource, User } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { Organization } from "~/models/organization.server";
import { Project } from "~/models/project.server";
import { Direction, RunList, RunListPresenter } from "./RunListPresenter.server";

export class TriggerSourcePresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    organizationSlug,
    triggerSourceId,
    direction = "forward",
    cursor,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    organizationSlug: Organization["slug"];
    triggerSourceId: TriggerSource["id"];
    direction?: Direction;
    cursor?: string;
  }) {
    const trigger = await this.#prismaClient.triggerSource.findUnique({
      select: {
        id: true,
        active: true,
        integration: {
          select: {
            id: true,
            title: true,
            slug: true,
            definitionId: true,
            setupStatus: true,
            definition: {
              select: {
                icon: true,
              },
            },
          },
        },
        environment: {
          select: {
            type: true,
          },
        },
        createdAt: true,
        updatedAt: true,
        params: true,
        sourceRegistrationJob: {
          select: {
            job: {
              select: {
                id: true,
                slug: true,
              },
            },
          },
        },
        dynamicTrigger: {
          select: {
            id: true,
            slug: true,
            sourceRegistrationJob: {
              select: {
                job: {
                  select: {
                    id: true,
                    slug: true,
                  },
                },
              },
            },
          },
        },
      },
      where: {
        id: triggerSourceId,
      },
    });

    if (!trigger) {
      throw new Error("Trigger source not found");
    }

    const runListPresenter = new RunListPresenter(this.#prismaClient);
    const jobSlug = getJobSlug(
      trigger.sourceRegistrationJob?.job.slug,
      trigger.dynamicTrigger?.sourceRegistrationJob?.job.slug
    );

    const runList = jobSlug
      ? await runListPresenter.call({
          userId,
          jobSlug,
          organizationSlug,
          projectSlug,
          direction,
          cursor,
        })
      : undefined;

    return {
      trigger: {
        id: trigger.id,
        active: trigger.active,
        integration: trigger.integration,
        environment: trigger.environment,
        createdAt: trigger.createdAt,
        updatedAt: trigger.updatedAt,
        params: trigger.params,
        registrationJob: trigger.sourceRegistrationJob?.job,
        runList,
        dynamic: trigger.dynamicTrigger
          ? { id: trigger.dynamicTrigger.id, slug: trigger.dynamicTrigger.slug }
          : undefined,
      },
    };
  }
}

function getJobSlug(
  sourceRegistrationJobSlug: string | undefined,
  dynamicSourceRegistrationJobSlug: string | undefined
) {
  if (sourceRegistrationJobSlug) {
    return sourceRegistrationJobSlug;
  }

  return dynamicSourceRegistrationJobSlug;
}
