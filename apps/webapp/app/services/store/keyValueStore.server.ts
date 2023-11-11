import { Prisma, RuntimeEnvironment } from "@trigger.dev/database";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";

interface AsyncMap {
  get: (key: string) => Promise<any>;
  set: (key: string, value: any) => Promise<any>;
  delete: (key: string) => Promise<boolean>;
}

export class KeyValueStore implements AsyncMap {
  #prismaClient: PrismaClient;

  constructor(private environment: RuntimeEnvironment, prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async get(key: string) {
    const keyValueItem = await this.#prismaClient.keyValueItem.findUnique({
      where: {
        projectId_key: {
          key,
          projectId: this.environment.projectId,
        },
      },
    });

    if (!keyValueItem) {
      return undefined;
    }

    return keyValueItem.value;
  }

  async set(key: string, value: any): Promise<any> {
    const jsonValue = JSON.parse(JSON.stringify(value)) as Exclude<Prisma.JsonValue, null>;

    const keyValueItem = await this.#prismaClient.keyValueItem.upsert({
      where: {
        projectId_key: {
          key,
          projectId: this.environment.projectId,
        },
      },
      create: {
        key,
        projectId: this.environment.projectId,
        value: jsonValue,
      },
      update: {
        value: jsonValue,
      },
    });

    return keyValueItem.value;
  }

  async delete(key: string) {
    try {
      await this.#prismaClient.keyValueItem.delete({
        where: {
          projectId_key: {
            key,
            projectId: this.environment.projectId,
          },
        },
      });

      return true;
    } catch (error) {
      return false;
    }
  }
}
