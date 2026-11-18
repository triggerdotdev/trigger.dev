import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Redis } from "@internal/redis";
import { boundedIn, type PrismaClient, type PrismaTransactionClient } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import {
  migrateEnvironmentEncryption,
  type EnvironmentMigrationProgress,
} from "./migration.server";
import type { EnvironmentEncryptionService } from "./service.server";

export type BackfillOperation = "inspect" | "enroll" | "migrate" | "verify";
type Status = "queued" | "running" | "completed" | "stopped" | "failed";
type BackfillEnvironment = {
  id: string;
  projectId: string;
  organizationId: string;
  label: string;
  activeKeyId: string | null;
  wrappingProvider: string | null;
  wrappingKeyReference: string | null;
  status: "pending" | "running" | "completed";
  progress?: EnvironmentMigrationProgress;
};
export type EncryptionBackfillJob = {
  id: string;
  operation: BackfillOperation;
  status: Status;
  actorId: string;
  updatedAt: string;
  organizations: Array<{ id: string; title: string }>;
  environments: BackfillEnvironment[];
  error?: string;
};

const STATE_KEY = "{environment-encryption-backfill}:state";
const LEASE_KEY = "{environment-encryption-backfill}:lease";
const LEASE_MS = 5 * 60_000;
const BATCH_SIZE = 25;
const PAUSE_MS = 1_000;
const MAX_ORGANIZATIONS = 50;
const MAX_ENVIRONMENTS = 1_000;

export class EnvironmentEncryptionBackfill {
  constructor(
    private readonly options: {
      db: PrismaClient;
      redis: Redis;
      encryption: EnvironmentEncryptionService;
      transaction: <T>(fn: (tx: PrismaTransactionClient) => Promise<T>) => Promise<T | undefined>;
    }
  ) {}

  async current(): Promise<EncryptionBackfillJob | null> {
    const value = await this.options.redis.hget(STATE_KEY, "job");
    return value ? (JSON.parse(value) as EncryptionBackfillJob) : null;
  }

  async create(operation: BackfillOperation, organizationIds: string[], actorId: string) {
    const ids = [...new Set(organizationIds.map((id) => id.trim()).filter(Boolean))];
    if (!ids.length || ids.length > MAX_ORGANIZATIONS)
      throw new Error(`Choose between 1 and ${MAX_ORGANIZATIONS} organization IDs`);
    const organizations = await this.options.db.organization.findMany({
      where: { id: { in: boundedIn(ids) } },
      select: { id: true, title: true },
      orderBy: { id: "asc" },
    });
    if (organizations.length !== ids.length)
      throw new Error("Some organization IDs were not found");
    const environments = await this.options.db.runtimeEnvironment.findMany({
      where: { organizationId: { in: boundedIn(ids) } },
      select: {
        id: true,
        projectId: true,
        organizationId: true,
        slug: true,
        branchName: true,
        project: { select: { name: true } },
        encryptionPolicy: true,
      },
      orderBy: [{ organizationId: "asc" }, { id: "asc" }],
      take: MAX_ENVIRONMENTS + 1,
    });
    if (!environments.length) throw new Error("No environments found for these organizations");
    if (environments.length > MAX_ENVIRONMENTS)
      throw new Error(`Choose a smaller cohort (at most ${MAX_ENVIRONMENTS} environments)`);
    if (operation === "migrate" && environments.some((env) => !env.encryptionPolicy?.activeKeyId))
      throw new Error("Enroll all cohort environments before migrating");
    const job: EncryptionBackfillJob = {
      id: randomUUID(),
      operation,
      status: "queued",
      actorId,
      updatedAt: new Date().toISOString(),
      organizations,
      environments: environments.map((env) => ({
        id: env.id,
        projectId: env.projectId,
        organizationId: env.organizationId,
        label: `${env.project.name} / ${env.slug}${env.branchName ? ` / ${env.branchName}` : ""}`,
        activeKeyId: env.encryptionPolicy?.activeKeyId ?? null,
        wrappingProvider: env.encryptionPolicy?.wrappingProvider ?? null,
        wrappingKeyReference: env.encryptionPolicy?.wrappingKeyReference ?? null,
        status: "pending",
      })),
    };
    const created = await this.options.redis.eval(
      `
      local status = redis.call('HGET', KEYS[1], 'status')
      if status == 'queued' or status == 'running' then return 0 end
      redis.call('HSET', KEYS[1], 'job', ARGV[1], 'id', ARGV[2], 'status', 'queued', 'stop', '0')
      return 1
    `,
      1,
      STATE_KEY,
      JSON.stringify(job),
      job.id
    );
    if (!created) throw new Error("Another cohort job is active; stop it or wait for completion");
    return job;
  }

  async stop(id: string) {
    await this.options.redis.eval(
      `
      if redis.call('HGET', KEYS[1], 'id') ~= ARGV[1] then return end
      redis.call('HSET', KEYS[1], 'stop', '1')
      local status = redis.call('HGET', KEYS[1], 'status')
      if (status == 'queued' or status == 'running') and redis.call('EXISTS', KEYS[2]) == 0 then
        local job = cjson.decode(redis.call('HGET', KEYS[1], 'job'))
        job.status = 'stopped'
        job.updatedAt = ARGV[2]
        redis.call('HSET', KEYS[1], 'job', cjson.encode(job), 'status', 'stopped')
      end
    `,
      2,
      STATE_KEY,
      LEASE_KEY,
      id,
      new Date().toISOString()
    );
  }

  async enqueueFailed(id: string) {
    await this.options.redis.eval(
      `
      local value = redis.call('HGET', KEYS[1], 'job')
      if not value then return end
      local job = cjson.decode(value)
      if job.id == ARGV[1] and job.status == 'queued' then
        job.status = 'failed'
        job.error = 'Could not enqueue job. Retry the operation.'
        redis.call('HSET', KEYS[1], 'job', cjson.encode(job), 'status', 'failed')
      end
    `,
      1,
      STATE_KEY,
      id
    );
  }

  async run(id: string) {
    const token = randomUUID();
    const acquired = await this.options.redis.set(LEASE_KEY, token, "PX", LEASE_MS, "NX");
    if (!acquired) throw new Error("Encryption backfill worker is already running");
    try {
      const job = await this.current();
      if (!job || job.id !== id || !["queued", "running"].includes(job.status)) return;
      const checkLease = async () => {
        const result = await this.options.redis.eval(
          `
          if redis.call('GET', KEYS[2]) ~= ARGV[1] then return -1 end
          if redis.call('HGET', KEYS[1], 'id') ~= ARGV[2] then return -1 end
          redis.call('PEXPIRE', KEYS[2], ARGV[3])
          return tonumber(redis.call('HGET', KEYS[1], 'stop') or '0')
        `,
          2,
          STATE_KEY,
          LEASE_KEY,
          token,
          id,
          LEASE_MS
        );
        if (result === -1) throw new Error("Encryption backfill worker lost its lease");
        return result === 0;
      };
      const save = async () => {
        job.updatedAt = new Date().toISOString();
        const saved = await this.options.redis.eval(
          `
          if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
          if redis.call('HGET', KEYS[1], 'id') ~= ARGV[2] then return 0 end
          redis.call('HSET', KEYS[1], 'job', ARGV[3], 'status', ARGV[5])
          redis.call('PEXPIRE', KEYS[2], ARGV[4])
          return 1
        `,
          2,
          STATE_KEY,
          LEASE_KEY,
          token,
          id,
          JSON.stringify(job),
          LEASE_MS,
          job.status
        );
        if (!saved) throw new Error("Encryption backfill worker lost its lease");
      };
      job.status = "running";
      await save();
      try {
        for (const environment of job.environments) {
          if (!(await checkLease())) {
            job.status = "stopped";
            break;
          }
          if (environment.status === "completed") continue;
          environment.status = "running";
          environment.progress = undefined;
          await save();
          const scope = { projectId: environment.projectId, environmentId: environment.id };
          if (job.operation === "enroll") {
            const prepared = await this.options.encryption.prepareWrite(scope);
            if (!prepared.keyId) {
              job.error =
                "Enrollment is disabled for this environment. Check deployment/org flags.";
              job.status = "failed";
              break;
            }
          }
          const policy = (await this.options.encryption.policies([scope], true)).get(
            environment.id
          )!.policy;
          environment.activeKeyId = policy?.activeKeyId ?? null;
          environment.wrappingProvider = policy?.wrappingProvider ?? null;
          environment.wrappingKeyReference = policy?.wrappingKeyReference ?? null;
          if (job.operation === "migrate" && !policy?.activeKeyId) {
            job.error = "Environment is not enrolled. No further environments processed.";
            job.status = "failed";
            break;
          }
          if (job.operation !== "enroll") {
            environment.progress = await migrateEnvironmentEncryption({
              db: this.options.db,
              encryption: this.options.encryption,
              encryptionTransaction: async (fn) => {
                await checkLease();
                return this.options.transaction(fn);
              },
              ...scope,
              apply: job.operation === "migrate",
              batchSize: BATCH_SIZE,
              pauseMs: PAUSE_MS,
              shouldContinue: checkLease,
              onProgress: async (progress) => {
                environment.progress = progress;
                await save();
              },
            });
            if (environment.progress.stopped) {
              job.status = "stopped";
              break;
            }
          }
          environment.status = "completed";
          await save();
          await sleep(PAUSE_MS);
        }
        if (job.status === "running") job.status = "completed";
      } catch (error) {
        logger.error("Environment encryption backfill failed", {
          jobId: id,
          operation: job.operation,
          environmentId: job.environments.find((environment) => environment.status === "running")
            ?.id,
          errorType: error instanceof Error ? error.name : typeof error,
          causeType:
            error instanceof Error && error.cause instanceof Error ? error.cause.name : undefined,
        });
        job.status = "failed";
        job.error =
          "Environment operation failed. No further environments processed. Check key access and run Inspect/Verify before retrying.";
      }
      await save();
    } finally {
      await this.options.redis.eval(
        `
        if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
      `,
        1,
        LEASE_KEY,
        token
      );
    }
  }
}
