import { type RuntimeEnvironment } from "@trigger.dev/database";
import { type AsyncMap } from '@trigger.dev/core/types';
import { prisma ,type  PrismaClient  } from "~/db.server";
import { logger } from "../logger.server";

export class KeyValueStore implements AsyncMap {
  #prismaClient: PrismaClient;

  constructor(private environment: RuntimeEnvironment, prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async delete(key: string): Promise<boolean> {
    try {
      await this.#prismaClient.keyValueItem.delete({
        select: {
          id: true,
        },
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

  async get(key: string): Promise<string | undefined> {
    const keyValueItem = await this.#prismaClient.keyValueItem.findUnique({
      select: {
        value: true,
      },
      where: {
        environmentId_key: {
          key,
          environmentId: this.environment.id,
        },
      },
    });

    if (!keyValueItem) {
      logger.debug("KeyValueStore.get() key not found", { key, environment: this.environment.id });
      return undefined;
    }

    return keyValueItem.value.toString();
  }

  async has(key: string): Promise<boolean> {
    const keyValueItem = await this.#prismaClient.keyValueItem.findUnique({
      select: {
        id: true,
      },
      where: {
        environmentId_key: {
          key,
          environmentId: this.environment.id,
        },
      },
    });

    return !!keyValueItem;
  }

  async set<TValue extends string>(key: string, value: TValue): Promise<TValue> {
    const valueBuffer = Buffer.from(value);

    await this.#prismaClient.keyValueItem.upsert({
      select: {
        value: true,
      },
      where: {
        environmentId_key: {
          key,
          environmentId: this.environment.id,
        },
      },
      create: {
        key,
        environmentId: this.environment.id,
        value: valueBuffer,
      },
      update: {
        value: valueBuffer,
      },
    });

    return value;
  }
}
