import { Tracer } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { PrismaClient } from "@trigger.dev/database";
import { RunQueue } from "../../run-queue/index.js";
import { EventBus } from "../eventBus.js";
import { RunLocker } from "../locking.js";
import { EngineWorker } from "../types.js";

export type SystemResources = {
  prisma: PrismaClient;
  worker: EngineWorker;
  eventBus: EventBus;
  logger: Logger;
  tracer: Tracer;
  runLock: RunLocker;
  runQueue: RunQueue;
};
