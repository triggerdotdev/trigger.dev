import { RunEngine } from "@internal/run-engine";
import { trace } from "@opentelemetry/api";
import type { PrismaClient } from "@trigger.dev/database";
import type { RedisOptions } from "ioredis";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import type {
  ExternalDeploymentCache,
  ExternalDeploymentCacheEntry,
} from "~/services/externalDeploymentCache.server";
import { RunEngineTriggerTaskService } from "../../app/runEngine/services/triggerTask.server";
import {
  MockPayloadProcessor,
  MockTraceEventConcern,
  MockTriggerTaskValidator,
} from "./triggerTaskTestHelpers";

export class RecordingExternalDeploymentCache implements ExternalDeploymentCache {
  readonly gets: Array<{ environmentId: string; externalId: string }> = [];
  readonly writes: Array<{ externalId: string; entry: ExternalDeploymentCacheEntry }> = [];

  constructor(private readonly entries = new Map<string, ExternalDeploymentCacheEntry>()) {}

  readonly missing: string[] = [];

  async get(environmentId: string, externalId: string) {
    this.gets.push({ environmentId, externalId });

    const entry = this.entries.get(externalId);

    if (entry) {
      return { outcome: "deployed" as const, entry };
    }

    return this.missing.includes(externalId) ? { outcome: "missing" as const } : null;
  }

  async setIfNewer(
    _environmentId: string,
    externalId: string,
    entry: ExternalDeploymentCacheEntry
  ) {
    this.writes.push({ externalId, entry });
    this.entries.set(externalId, entry);
  }

  async setMissing(_environmentId: string, externalId: string) {
    this.missing.push(externalId);
  }
}

export function createEngine(prisma: PrismaClient, redisOptions: RedisOptions) {
  return new RunEngine({
    prisma,
    worker: { redis: redisOptions, disabled: true },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      ttlSystem: { disabled: true },
    },
    batchQueue: { redis: redisOptions, consumerEnabled: false },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0005,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

export function createService(
  prisma: PrismaClient,
  engine: RunEngine,
  externalDeploymentCache: ExternalDeploymentCache
) {
  return new RunEngineTriggerTaskService({
    engine,
    prisma,
    payloadProcessor: new MockPayloadProcessor(),
    queueConcern: new DefaultQueueManager(prisma, engine),
    idempotencyKeyConcern: new IdempotencyKeyConcern(prisma, engine, new MockTraceEventConcern()),
    validator: new MockTriggerTaskValidator(),
    traceEventConcern: new MockTraceEventConcern(),
    tracer: trace.getTracer("test", "0.0.0"),
    metadataMaximumSize: 1024 * 1024,
    externalDeploymentCache,
  });
}

export async function nameDeploymentWithExternalId(
  prisma: PrismaClient,
  workerId: string,
  externalId: string
) {
  await prisma.workerDeployment.update({ where: { workerId }, data: { externalId } });
}
