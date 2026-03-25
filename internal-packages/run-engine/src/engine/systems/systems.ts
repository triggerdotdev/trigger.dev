import { Meter, Tracer } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { PrismaClient, PrismaReplicaClient } from "@trigger.dev/database";
import { RunQueue } from "../../run-queue/index.js";
import { EventBus } from "../eventBus.js";
import { RunLocker } from "../locking.js";
import { EngineWorker } from "../types.js";
import { RaceSimulationSystem } from "./raceSimulationSystem.js";

export type SystemResources = {
  prisma: PrismaClient;
  readOnlyPrisma: PrismaReplicaClient;
  worker: EngineWorker;
  eventBus: EventBus;
  logger: Logger;
  tracer: Tracer;
  meter: Meter;
  runLock: RunLocker;
  runQueue: RunQueue;
  raceSimulationSystem: RaceSimulationSystem;
};
