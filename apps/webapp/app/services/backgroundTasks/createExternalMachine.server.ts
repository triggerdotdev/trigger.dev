import { BackgroundTaskMachine } from "@trigger.dev/database";
import type { PrismaClientOrTransaction } from "~/db.server";
import { prisma } from "~/db.server";
import { workerQueue } from "../worker.server";
import { backgroundTaskProvider } from "./provider.server";
import { resolveBackgroundTaskSecret } from "~/models/backgroundTaskSecret.server";
import { env } from "~/env.server";
import { ExternalMachineConfig } from "./providers/types";

export class CreateExternalMachineService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const machine = await this.#prismaClient.backgroundTaskMachine.findUniqueOrThrow({
      where: {
        id,
      },
      include: {
        pool: {
          include: {
            image: true,
            backgroundTask: true,
            backgroundTaskVersion: {
              include: {
                environment: true,
                secrets: {
                  include: {
                    secretReference: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    const envVars: Record<string, string> = {};

    for (const secret of machine.pool.backgroundTaskVersion.secrets) {
      const secretValue = await resolveBackgroundTaskSecret(secret.secretReference);

      if (!secretValue) {
        continue;
      }

      envVars[secret.key] = secretValue;
    }

    envVars["TRIGGER_API_KEY"] = machine.pool.backgroundTaskVersion.environment.apiKey;
    envVars["TRIGGER_API_URL"] = env.APP_ORIGIN;
    envVars["TRIGGER_POOL_ID"] = machine.pool.id;
    envVars["TRIGGER_MACHINE_ID"] = machine.id;

    const config: ExternalMachineConfig = {
      cpus: machine.pool.cpu,
      memory: machine.pool.memory,
      diskSize: machine.pool.diskSize,
      region: machine.pool.region,
      env: envVars,
      image: `${backgroundTaskProvider.registry}/${machine.pool.image.name}:${machine.pool.image.tag}@${machine.pool.image.digest}`,
    };

    const externalMachine = await backgroundTaskProvider.createMachineForTask(
      machine.id,
      machine.pool.backgroundTask,
      config
    );

    await this.#prismaClient.backgroundTaskMachine.update({
      where: {
        id: machine.id,
      },
      data: {
        externalId: externalMachine.id,
        status: externalMachine.status,
        data: externalMachine.data,
      },
    });
  }

  static async enqueue(machine: BackgroundTaskMachine, tx: PrismaClientOrTransaction = prisma) {
    return await workerQueue.enqueue(
      "createExternalMachine",
      {
        id: machine.id,
      },
      {
        tx,
        jobKey: `createMachine:${machine.id}`,
      }
    );
  }
}
