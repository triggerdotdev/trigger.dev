import type { Meter, Tracer } from "@internal/tracing";
import type { RunStore } from "@internal/run-store";
import type { Logger } from "@trigger.dev/core/logger";
import type { PrismaClient, PrismaReplicaClient } from "@trigger.dev/database";
import type { RunQueue } from "../../run-queue/index.js";
import type { EventBus } from "../eventBus.js";
import type { RunLocker } from "../locking.js";
import type { PendingVersionRunIdLookup } from "../services/pendingVersionLookup.js";
import type { EngineWorker } from "../types.js";
import type { RaceSimulationSystem } from "./raceSimulationSystem.js";

export type SystemResources = {
  prisma: PrismaClient;
  readOnlyPrisma: PrismaReplicaClient;
  runStore: RunStore;
  worker: EngineWorker;
  eventBus: EventBus;
  logger: Logger;
  tracer: Tracer;
  meter: Meter;
  runLock: RunLocker;
  runQueue: RunQueue;
  raceSimulationSystem: RaceSimulationSystem;
  pendingVersionRunIdLookup: PendingVersionRunIdLookup;
};
