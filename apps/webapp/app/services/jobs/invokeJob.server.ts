import { $transaction, type PrismaClient, prisma } from "~/db.server";
import { type AuthenticatedEnvironment } from "../apiAuth.server";
import { type InvokeJobRequestBody } from '@trigger.dev/core/schemas';
import { ulid } from "../ulid.server";
import { CreateRunService } from "../runs/createRun.server";

export class InvokeJobService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    environment: AuthenticatedEnvironment,
    jobSlug: string,
    data: InvokeJobRequestBody,
    idempotencyKey?: string
  ) {
    return await $transaction(this.#prismaClient, async (tx) => {
      // Check if this is an idempotent request
      if (idempotencyKey) {
        const existingEvent = await tx.eventRecord.findUnique({
          where: {
            eventId_environmentId: {
              eventId: idempotencyKey,
              environmentId: environment.id,
            },
          },
          include: {
            runs: true,
          },
        });

        if (existingEvent) {
          return existingEvent.runs[0];
        }
      }

      const job = await tx.job.findUniqueOrThrow({
        where: {
          projectId_slug: {
            projectId: environment.projectId,
            slug: jobSlug,
          },
        },
        include: {
          aliases: {
            where: {
              environmentId: environment.id,
              name: "latest",
            },
            include: {
              version: true,
            },
            take: 1,
          },
        },
      });

      const alias = job.aliases[0];

      if (!alias) {
        throw new Error(`No version found for job ${jobSlug} in environment ${environment.slug}`);
      }

      const version = alias.version;

      if (!version) {
        throw new Error(`No version found for job ${jobSlug} in environment ${environment.slug}`);
      }

      const options = data.options ?? {};

      const externalAccount = options.accountId
        ? await tx.externalAccount.upsert({
            where: {
              environmentId_identifier: {
                environmentId: environment.id,
                identifier: options.accountId,
              },
            },
            create: {
              environmentId: environment.id,
              organizationId: environment.organizationId,
              identifier: options.accountId,
            },
            update: {},
          })
        : undefined;

      const eventLog = await tx.eventRecord.create({
        data: {
          organization: {
            connect: {
              id: environment.organizationId,
            },
          },
          project: {
            connect: {
              id: environment.projectId,
            },
          },
          environment: {
            connect: {
              id: environment.id,
            },
          },
          externalAccount: externalAccount
            ? {
                connect: {
                  id: externalAccount.id,
                },
              }
            : undefined,
          eventId: idempotencyKey ?? ulid(),
          name: "invoke",
          timestamp: new Date(),
          payload: data.payload ?? {},
          context: data.context ?? {},
          source: "trigger.dev",
          internal: true,
        },
      });

      const createRunService = new CreateRunService(tx);

      const run = await createRunService.call(
        {
          environment,
          eventId: eventLog.id,
          job: job,
          version,
        },
        {
          callbackUrl: options.callbackUrl,
        }
      );

      return run;
    });
  }
}
