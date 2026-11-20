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
type Environment = { id: string; projectId: string; organizationId: string; label: string };
type Cursor = { organizationId: string; environmentId: string };
export type EncryptionBackfillPage = {
  id: string;
  number: number;
  organizations: Array<{ id: string; title: string }>;
  environments: Environment[];
  after: Cursor | null;
  nextCursor: Cursor | null;
};
export type EncryptionBackfillJob = {
  id: string;
  pageId: string;
  operation: BackfillOperation;
  status: Status;
  actorId: string;
  updatedAt: string;
  completedEnvironments: number;
  currentEnvironment:
    | (Environment & {
        activeKeyId: string | null;
        wrappingProvider: string | null;
        wrappingKeyReference: string | null;
      })
    | null;
  progress: EnvironmentMigrationProgress;
  completedProgress: EnvironmentMigrationProgress;
  enrolledEnvironments: number;
  kmsEnvironments: number;
  keyringEnvironments: number;
  error?: string;
};

const STATE_KEY = "{environment-encryption-backfill}:state";
const LEASE_KEY = "{environment-encryption-backfill}:lease";
const LEASE_MS = 5 * 60_000;
const BATCH_SIZE = 25;
const PAUSE_MS = 100;
const MAX_ORGANIZATIONS = 50;
const PAGE_SIZE = 1_000;

function emptyProgress(): EnvironmentMigrationProgress {
  return {
    scanned: 0,
    rewritten: 0,
    conflicts: 0,
    remaining: 0,
    runtimeValues: 0,
    buildEnvelopes: 0,
    stopped: false,
  };
}
function addProgress(
  a: EnvironmentMigrationProgress,
  b: EnvironmentMigrationProgress
): EnvironmentMigrationProgress {
  return {
    scanned: a.scanned + b.scanned,
    rewritten: a.rewritten + b.rewritten,
    conflicts: a.conflicts + b.conflicts,
    remaining: a.remaining + b.remaining,
    runtimeValues: a.runtimeValues + b.runtimeValues,
    buildEnvelopes: a.buildEnvelopes + b.buildEnvelopes,
    stopped: b.stopped,
  };
}
function newJob(
  operation: BackfillOperation,
  pageId: string,
  actorId: string
): EncryptionBackfillJob {
  return {
    id: randomUUID(),
    pageId,
    operation,
    status: "queued",
    actorId,
    updatedAt: new Date().toISOString(),
    completedEnvironments: 0,
    currentEnvironment: null,
    progress: emptyProgress(),
    completedProgress: emptyProgress(),
    enrolledEnvironments: 0,
    kmsEnvironments: 0,
    keyringEnvironments: 0,
  };
}

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
    if (!value) return null;
    const job = JSON.parse(value) as EncryptionBackfillJob;
    if (job.pageId) return job;
    // Old deployed jobs can still be stopped, but are not resumed with a different scope/format.
    return {
      ...newJob(job.operation, "legacy", job.actorId),
      id: job.id,
      status: job.status,
      updatedAt: job.updatedAt,
      error: "Previous-version job. Stop it before selecting a paged cohort.",
    };
  }

  async page(): Promise<EncryptionBackfillPage | null> {
    const value = await this.options.redis.hget(STATE_KEY, "page");
    return value ? (JSON.parse(value) as EncryptionBackfillPage) : null;
  }

  async pageVerified() {
    const [pageId, verified] = await this.options.redis.hmget(STATE_KEY, "pageId", "verified");
    return !!pageId && pageId === verified;
  }

  async selectPage(organizationIds: string[], previousPageId = "") {
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
    return this.#savePage(await this.#loadPage(organizations, null, 1), previousPageId);
  }

  async nextPage(pageId: string) {
    const page = await this.page();
    if (!page || page.id !== pageId) throw new Error("Page changed; refresh before continuing");
    if (!(await this.pageVerified()))
      throw new Error("Verify this page successfully before advancing");
    if (!page.nextCursor) throw new Error("No more pages for this selection");
    return this.#savePage(
      await this.#loadPage(page.organizations, page.nextCursor, page.number + 1),
      pageId,
      true
    );
  }

  async #loadPage(
    organizations: EncryptionBackfillPage["organizations"],
    after: Cursor | null,
    number: number
  ): Promise<EncryptionBackfillPage> {
    const rows = await this.options.db.runtimeEnvironment.findMany({
      where: {
        organizationId: { in: boundedIn(organizations.map((org) => org.id)) },
        ...(after
          ? {
              OR: [
                { organizationId: { gt: after.organizationId } },
                { organizationId: after.organizationId, id: { gt: after.environmentId } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        projectId: true,
        organizationId: true,
        slug: true,
        branchName: true,
        project: { select: { name: true } },
      },
      orderBy: [{ organizationId: "asc" }, { id: "asc" }],
      take: PAGE_SIZE + 1,
    });
    if (!rows.length)
      throw new Error("No environments found after this cursor. Start a new selection to rescan.");
    const selected = rows.slice(0, PAGE_SIZE);
    const last = selected[selected.length - 1]!;
    return {
      id: randomUUID(),
      number,
      organizations,
      after,
      environments: selected.map((env) => ({
        id: env.id,
        projectId: env.projectId,
        organizationId: env.organizationId,
        label: `${env.project.name} / ${env.slug}${env.branchName ? ` / ${env.branchName}` : ""}`,
      })),
      nextCursor:
        rows.length > PAGE_SIZE
          ? { organizationId: last.organizationId, environmentId: last.id }
          : null,
    };
  }

  async #savePage(page: EncryptionBackfillPage, previousPageId: string, requireVerified = false) {
    const saved = await this.options.redis.eval(
      `
      local status = redis.call('HGET', KEYS[1], 'status')
      if status == 'queued' or status == 'running' then return 0 end
      if (redis.call('HGET', KEYS[1], 'pageId') or '') ~= ARGV[3] then return -1 end
      if ARGV[4] == '1' and redis.call('HGET', KEYS[1], 'verified') ~= ARGV[3] then return -1 end
      redis.call('HSET', KEYS[1], 'page', ARGV[1], 'pageId', ARGV[2], 'verified', '', 'status', 'ready', 'id', '', 'stop', '0')
      redis.call('HDEL', KEYS[1], 'job')
      return 1
    `,
      1,
      STATE_KEY,
      JSON.stringify(page),
      page.id,
      previousPageId,
      requireVerified ? "1" : "0"
    );
    if (saved === 0) throw new Error("Another page job is active; stop it or wait for completion");
    if (saved === -1)
      throw new Error("Page changed or is no longer verified; refresh before continuing");
    return page;
  }

  async create(operation: BackfillOperation, pageId: string, actorId: string) {
    const page = await this.page();
    if (!page || page.id !== pageId)
      throw new Error("Page changed; select or refresh the page first");
    if (operation === "migrate") {
      const enrolled = await this.options.db.runtimeEnvironment.count({
        where: {
          id: { in: boundedIn(page.environments.map((environment) => environment.id)) },
          encryptionPolicy: { is: { activeKeyId: { not: null } } },
        },
      });
      if (enrolled !== page.environments.length)
        throw new Error("All page environments must exist and be enrolled before migrating");
    }
    const job = newJob(operation, page.id, actorId);
    const created = await this.options.redis.eval(
      `
      if redis.call('HGET', KEYS[1], 'pageId') ~= ARGV[3] then return -1 end
      local status = redis.call('HGET', KEYS[1], 'status')
      if status == 'queued' or status == 'running' then return 0 end
      redis.call('HSET', KEYS[1], 'job', ARGV[1], 'id', ARGV[2], 'status', 'queued', 'stop', '0', 'verified', '')
      return 1
    `,
      1,
      STATE_KEY,
      JSON.stringify(job),
      job.id,
      pageId
    );
    if (created === 0)
      throw new Error("Another page job is active; stop it or wait for completion");
    if (created === -1) throw new Error("Page changed; refresh before continuing");
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
    if (!(await this.options.redis.set(LEASE_KEY, token, "PX", LEASE_MS, "NX")))
      throw new Error("Encryption backfill worker is already running");
    try {
      const job = await this.current();
      const page = await this.page();
      if (
        !job ||
        job.id !== id ||
        !["queued", "running"].includes(job.status) ||
        !page ||
        page.id !== job.pageId
      )
        return;
      const checkLease = async () => {
        const result = await this.options.redis.eval(
          `
          if redis.call('GET', KEYS[2]) ~= ARGV[1] then return -1 end
          if redis.call('HGET', KEYS[1], 'id') ~= ARGV[2] or redis.call('HGET', KEYS[1], 'pageId') ~= ARGV[4] then return -1 end
          redis.call('PEXPIRE', KEYS[2], ARGV[3])
          return tonumber(redis.call('HGET', KEYS[1], 'stop') or '0')
        `,
          2,
          STATE_KEY,
          LEASE_KEY,
          token,
          id,
          LEASE_MS,
          page.id
        );
        if (result === -1) throw new Error("Encryption backfill worker lost its lease");
        return result === 0;
      };
      const save = async () => {
        job.updatedAt = new Date().toISOString();
        const verified =
          job.operation === "verify" &&
          job.status === "completed" &&
          job.progress.remaining === 0 &&
          job.completedEnvironments === page.environments.length;
        const saved = await this.options.redis.eval(
          `
          if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
          if redis.call('HGET', KEYS[1], 'id') ~= ARGV[2] or redis.call('HGET', KEYS[1], 'pageId') ~= ARGV[6] then return 0 end
          redis.call('HSET', KEYS[1], 'job', ARGV[3], 'status', ARGV[5])
          if ARGV[7] == '1' then redis.call('HSET', KEYS[1], 'verified', ARGV[6]) end
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
          job.status,
          page.id,
          verified ? "1" : "0"
        );
        if (!saved) throw new Error("Encryption backfill worker lost its lease");
      };
      job.status = "running";
      await save();
      try {
        for (let index = job.completedEnvironments; index < page.environments.length; index++) {
          if (!(await checkLease())) {
            job.status = "stopped";
            break;
          }
          const environment = page.environments[index]!;
          job.currentEnvironment = {
            ...environment,
            activeKeyId: null,
            wrappingProvider: null,
            wrappingKeyReference: null,
          };
          job.progress = { ...job.completedProgress };
          await save();
          const scope = { projectId: environment.projectId, environmentId: environment.id };
          if (
            job.operation === "enroll" &&
            !(await this.options.encryption.prepareWrite(scope)).keyId
          ) {
            job.error = "Enrollment is disabled for this environment. Check deployment/org flags.";
            job.status = "failed";
            break;
          }
          const policy = (await this.options.encryption.policies([scope], true)).get(
            environment.id
          )!.policy;
          job.currentEnvironment.activeKeyId = policy?.activeKeyId ?? null;
          job.currentEnvironment.wrappingProvider = policy?.wrappingProvider ?? null;
          job.currentEnvironment.wrappingKeyReference = policy?.wrappingKeyReference ?? null;
          if (job.operation === "migrate" && !policy?.activeKeyId) {
            job.error = "Environment is not enrolled. No further environments processed.";
            job.status = "failed";
            break;
          }
          if (job.operation !== "enroll") {
            const progress = await migrateEnvironmentEncryption({
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
                job.progress = addProgress(job.completedProgress, progress);
                await save();
              },
            });
            job.progress = addProgress(job.completedProgress, progress);
            if (progress.stopped) {
              job.status = "stopped";
              break;
            }
          }
          job.completedProgress = { ...job.progress };
          job.completedEnvironments++;
          if (policy?.activeKeyId) {
            job.enrolledEnvironments++;
            if (policy.wrappingProvider === "AWS_KMS") job.kmsEnvironments++;
            if (policy.wrappingProvider === "PLATFORM_KEYRING") job.keyringEnvironments++;
          }
          await save();
          if (job.operation === "enroll") await sleep(PAUSE_MS);
        }
        if (job.status === "running") job.status = "completed";
      } catch (error) {
        logger.error("Environment encryption backfill failed", {
          jobId: id,
          operation: job.operation,
          environmentId: job.currentEnvironment?.id,
          errorType: error instanceof Error ? error.name : typeof error,
          causeType:
            error instanceof Error && error.cause instanceof Error ? error.cause.name : undefined,
        });
        job.status = "failed";
        job.error =
          "Environment operation failed. No further environments processed. Check key access and inspect/verify this page before retrying.";
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
