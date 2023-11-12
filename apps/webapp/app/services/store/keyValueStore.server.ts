import { Prisma, RuntimeEnvironment } from "@trigger.dev/database";
import type { AsyncMap } from "@trigger.dev/core";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";

export class KeyValueStore implements AsyncMap {
  #prismaClient: PrismaClient;

  constructor(private environment: RuntimeEnvironment, prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async get(key: string) {
    const keyValueItem = await this.#prismaClient.keyValueItem.findUnique({
      where: {
        environmentId_key: {
          key,
          environmentId: this.environment.id,
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
        environmentId_key: {
          key,
          environmentId: this.environment.id,
        },
      },
      create: {
        key,
        environmentId: this.environment.id,
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
          environmentId_key: {
            key,
            environmentId: this.environment.id,
          },
        },
      });

      return true;
    } catch (error) {
      return false;
    }
  }
}
