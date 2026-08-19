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
  readonly writes: Array<{
    environmentId: string;
    externalId: string;
    entry: ExternalDeploymentCacheEntry;
  }> = [];
  readonly missing: Array<{ environmentId: string; externalId: string }> = [];
  private readonly entries = new Map<string, ExternalDeploymentCacheEntry>();

  constructor(
    entries: Array<{
      environmentId: string;
      externalId: string;
      entry: ExternalDeploymentCacheEntry;
    }> = []
  ) {
    for (const { environmentId, externalId, entry } of entries) {
      this.entries.set(this.key(environmentId, externalId), entry);
    }
  }

  async get(environmentId: string, externalId: string) {
    this.gets.push({ environmentId, externalId });

    const entry = this.entries.get(this.key(environmentId, externalId));

    if (entry) {
      return { outcome: "deployed" as const, entry };
    }

    return this.missing.some(
      (missing) => missing.environmentId === environmentId && missing.externalId === externalId
    )
      ? { outcome: "missing" as const }
      : null;
  }

  async setIfNewer(environmentId: string, externalId: string, entry: ExternalDeploymentCacheEntry) {
    this.writes.push({ environmentId, externalId, entry });
    this.entries.set(this.key(environmentId, externalId), entry);
  }

  async setMissing(environmentId: string, externalId: string) {
    this.missing.push({ environmentId, externalId });
  }

  private key(environmentId: string, externalId: string) {
    return JSON.stringify([environmentId, externalId]);
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
