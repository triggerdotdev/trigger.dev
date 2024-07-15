import { type LogMessage } from '@trigger.dev/core/schemas';
import type { PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";

export class CreateRunLogService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(environment: AuthenticatedEnvironment, runId: string, logMessage: LogMessage) {
    // @ts-ignore
    logger.debug(logMessage.message, logMessage.data ?? {});

    return logMessage;
  }
}
