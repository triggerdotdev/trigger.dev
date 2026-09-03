import type { Meter, Tracer } from "@internal/tracing";
import type { RunStore } from "@internal/run-store";
import type { ControlPlaneResolver } from "../controlPlaneResolver.js";
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
  controlPlaneResolver: ControlPlaneResolver;
  worker: EngineWorker;
  eventBus: EventBus;
  logger: Logger;
  tracer: Tracer;
  meter: Meter;
  runLock: RunLocker;
  runQueue: RunQueue;
  raceSimulationSystem: RaceSimulationSystem;
  pendingVersionRunIdLookup: PendingVersionRunIdLookup;
  /**
   * Whether the connection-blip write-ahead guards are armed (wired to the runStoreInfraRetryEnabled
   * flag at the app boundary). Engine-internal paths (e.g. the enqueue publish guard) consult it,
   * since they have no per-request webapp entry point. Defaults to off.
   */
  isBlipRetryEnabled: () => boolean | Promise<boolean>;
  /** Grace before an unacked write-ahead guard fires. Short in tests. */
  guardDelayMs: number;
};
