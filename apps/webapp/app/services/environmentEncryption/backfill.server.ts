import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Redis } from "@internal/redis";
import { boundedIn, type PrismaClient, type PrismaTransactionClient } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { FEATURE_FLAG, isPlainFlagObject } from "~/v3/featureFlags";
import {
  migrateEnvironmentEncryption,
  type EnvironmentMigrationProgress,
} from "./migration.server";
import type { EnvironmentEncryptionService } from "./service.server";

export type BackfillOperation = "inspect" | "enroll" | "migrate" | "verify";
export type FleetOperation = "enroll" | "migrate";
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
  fleetOperation?: FleetOperation;
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
  skippedEnvironments: number;
  fleet?: {
    phase: "apply" | "verify";
    throughEnvironmentId: string | null;
    pageNumber: number;
    pageSize: number;
    completedPages: number;
    completedEnvironments: number;
    rewritten: number;
    conflicts: number;
    skippedEnvironments: number;
    pageProgress: EnvironmentMigrationProgress;
  };
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
    skippedEnvironments: 0,
  };
}

function resetPageProgress(job: EncryptionBackfillJob): EncryptionBackfillJob {
  return {
    ...job,
    completedEnvironments: 0,
    currentEnvironment: null,
    progress: emptyProgress(),
    completedProgress: emptyProgress(),
    enrolledEnvironments: 0,
    kmsEnvironments: 0,
    keyringEnvironments: 0,
    skippedEnvironments: 0,
    error: undefined,
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
    if (page.fleetOperation) throw new Error("Fleet pages advance automatically");
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
    if (page.fleetOperation) throw new Error("Use fleet controls or select a manual cohort");
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

  async createFleet(operation: FleetOperation, actorId: string, previousPageId: string) {
    const last = await this.options.db.runtimeEnvironment.findFirst({
      orderBy: { id: "desc" },
      select: { id: true },
    });
    const throughEnvironmentId = last?.id ?? null;
    const page = await this.#loadFleetPage(operation, throughEnvironmentId, null, 1);
    const job = newJob(operation, page.id, actorId);
    job.fleet = {
      phase: "apply",
      throughEnvironmentId,
      pageNumber: 1,
      pageSize: page.environments.length,
      completedPages: 0,
      completedEnvironments: 0,
      rewritten: 0,
      conflicts: 0,
      skippedEnvironments: 0,
      pageProgress: emptyProgress(),
    };
    const created = await this.options.redis.eval(
      `
      local status = redis.call('HGET', KEYS[1], 'status')
      if status == 'queued' or status == 'running' then return 0 end
      if (redis.call('HGET', KEYS[1], 'pageId') or '') ~= ARGV[3] then return -1 end
      redis.call('HSET', KEYS[1], 'page', ARGV[1], 'pageId', ARGV[2], 'job', ARGV[4], 'id', ARGV[5], 'verified', '', 'status', 'queued', 'stop', '0')
      return 1
    `,
      1,
      STATE_KEY,
      JSON.stringify(page),
      page.id,
      previousPageId,
      JSON.stringify(job),
      job.id
    );
    if (created === 0) throw new Error("Another job is active; stop it or wait for completion");
    if (created === -1) throw new Error("Page changed; refresh before starting a fleet pass");
    return job;
  }

  async resumeFleet(id: string, actorId: string) {
    const current = await this.current();
    const page = await this.page();
    if (!current?.fleet || current.id !== id || !page || page.id !== current.pageId)
      throw new Error("Fleet job changed; refresh before resuming");
    if (current.status !== "stopped" && current.status !== "failed")
      throw new Error("Only stopped or failed fleet jobs can be resumed");
    const job = resetPageProgress(current);
    job.fleet = { ...current.fleet, phase: "apply", pageProgress: emptyProgress() };
    job.status = "queued";
    job.actorId = actorId;
    job.updatedAt = new Date().toISOString();
    const resumed = await this.options.redis.eval(
      `
      if redis.call('HGET', KEYS[1], 'id') ~= ARGV[1] or redis.call('HGET', KEYS[1], 'pageId') ~= ARGV[2] then return 0 end
      local status = redis.call('HGET', KEYS[1], 'status')
      if status ~= 'stopped' and status ~= 'failed' then return 0 end
      redis.call('HSET', KEYS[1], 'job', ARGV[3], 'status', 'queued', 'stop', '0', 'verified', '')
      return 1
    `,
      1,
      STATE_KEY,
      id,
      page.id,
      JSON.stringify(job)
    );
    if (!resumed) throw new Error("Fleet job changed; refresh before resuming");
    return job;
  }

  async #loadFleetPage(
    operation: FleetOperation,
    through: string | null,
    after: Cursor | null,
    number: number
  ): Promise<EncryptionBackfillPage> {
    const page: EncryptionBackfillPage = {
      id: randomUUID(),
      number,
      organizations: [],
      after,
      fleetOperation: operation,
      environments: [],
      nextCursor: null,
    };
    if (!through) return page;
    const bounds = { lte: through, ...(after ? { gt: after.environmentId } : {}) };
    const select = {
      id: true,
      projectId: true,
      organizationId: true,
      slug: true,
      branchName: true,
      project: { select: { name: true } },
    } as const;
    const rows =
      operation === "migrate"
        ? (
            await this.options.db.environmentEncryptionPolicy.findMany({
              where: { environmentId: bounds, activeKeyId: { not: null } },
              select: { environment: { select } },
              orderBy: { environmentId: "asc" },
              take: PAGE_SIZE + 1,
            })
          ).map((policy) => policy.environment)
        : await this.options.db.runtimeEnvironment.findMany({
            where: {
              id: bounds,
              OR: [
                { encryptionPolicy: { is: null } },
                { encryptionPolicy: { is: { activeKeyId: null } } },
              ],
            },
            select,
            orderBy: { id: "asc" },
            take: PAGE_SIZE + 1,
          });
    const selected = rows.slice(0, PAGE_SIZE);
    const last = selected.at(-1);
    page.environments = selected.map((environment) => ({
      id: environment.id,
      projectId: environment.projectId,
      organizationId: environment.organizationId,
      label: `${environment.project.name} / ${environment.slug}${environment.branchName ? ` / ${environment.branchName}` : ""}`,
    }));
    page.nextCursor =
      rows.length > PAGE_SIZE && last
        ? { organizationId: last.organizationId, environmentId: last.id }
        : null;
    return page;
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

  async run(id: string): Promise<boolean> {
    const token = randomUUID();
    if (!(await this.options.redis.set(LEASE_KEY, token, "PX", LEASE_MS, "NX")))
      throw new Error("Encryption backfill worker is already running");
    try {
      const current = await this.current();
      const selected = await this.page();
      if (
        !current ||
        current.id !== id ||
        !["queued", "running"].includes(current.status) ||
        !selected ||
        selected.id !== current.pageId
      )
        return false;
      let job: EncryptionBackfillJob = current;
      let page: EncryptionBackfillPage = selected;
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
      const save = async (
        snapshot: EncryptionBackfillJob = job,
        nextPage?: EncryptionBackfillPage
      ) => {
        snapshot.updatedAt = new Date().toISOString();
        const verified =
          !snapshot.fleet &&
          snapshot.operation === "verify" &&
          snapshot.status === "completed" &&
          snapshot.progress.remaining === 0 &&
          snapshot.completedEnvironments === page.environments.length;
        const saved = await this.options.redis.eval(
          `
          if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
          if redis.call('HGET', KEYS[1], 'id') ~= ARGV[2] or redis.call('HGET', KEYS[1], 'pageId') ~= ARGV[6] then return 0 end
          redis.call('HSET', KEYS[1], 'job', ARGV[3], 'status', ARGV[5])
          if ARGV[7] == '1' then redis.call('HSET', KEYS[1], 'verified', ARGV[6]) end
          if ARGV[8] ~= '' then redis.call('HSET', KEYS[1], 'page', ARGV[8], 'pageId', ARGV[9], 'verified', '') end
          redis.call('PEXPIRE', KEYS[2], ARGV[4])
          return 1
        `,
          2,
          STATE_KEY,
          LEASE_KEY,
          token,
          id,
          JSON.stringify(snapshot),
          LEASE_MS,
          snapshot.status,
          page.id,
          verified ? "1" : "0",
          nextPage ? JSON.stringify(nextPage) : "",
          snapshot.pageId
        );
        if (!saved) throw new Error("Encryption backfill worker lost its lease");
        job = snapshot;
        if (nextPage) page = nextPage;
      };
      job.status = "running";
      await save();
      try {
        const operation = job.fleet?.phase === "verify" ? "verify" : job.operation;
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
            operation === "enroll" &&
            !(await this.options.encryption.prepareWrite(scope)).keyId
          ) {
            const organization = job.fleet
              ? await this.options.db.organization.findFirst({
                  where: { id: environment.organizationId },
                  select: { featureFlags: true },
                })
              : null;
            if (
              organization &&
              isPlainFlagObject(organization.featureFlags) &&
              organization.featureFlags[FEATURE_FLAG.environmentEncryptionEnabled] === false
            ) {
              job.skippedEnvironments++;
              job.completedEnvironments++;
              await save();
              continue;
            }
            job.error =
              "Enrollment is disabled for this environment. Check deployment/global/org flags.";
            job.status = "failed";
            break;
          }
          const policy = (await this.options.encryption.policies([scope], true)).get(
            environment.id
          )!.policy;
          job.currentEnvironment.activeKeyId = policy?.activeKeyId ?? null;
          job.currentEnvironment.wrappingProvider = policy?.wrappingProvider ?? null;
          job.currentEnvironment.wrappingKeyReference = policy?.wrappingKeyReference ?? null;
          if (operation === "migrate" && !policy?.activeKeyId) {
            job.error = "Environment is not enrolled. No further environments processed.";
            job.status = "failed";
            break;
          }
          if (operation !== "enroll") {
            const progress = await migrateEnvironmentEncryption({
              db: this.options.db,
              encryption: this.options.encryption,
              encryptionTransaction: async (fn) => {
                await checkLease();
                return this.options.transaction(fn);
              },
              ...scope,
              apply: operation === "migrate",
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
          if (operation === "enroll") await sleep(PAUSE_MS);
        }
        if (job.status === "running" && job.fleet) {
          if (!(await checkLease())) {
            job.status = "stopped";
          } else if (
            job.operation === "migrate" &&
            job.fleet.phase === "apply" &&
            page.environments.length
          ) {
            const next = resetPageProgress(job);
            next.fleet = { ...job.fleet, phase: "verify", pageProgress: { ...job.progress } };
            await save(next);
            return true;
          } else if (job.operation === "migrate" && job.progress.remaining) {
            job.status = "failed";
            job.error =
              "Fleet verification found values still needing migration. Resume to reapply and verify this page.";
          } else if (!page.environments.length) {
            job.status = "completed";
          } else {
            const last = page.environments[page.environments.length - 1]!;
            const nextPage = await this.#loadFleetPage(
              job.operation as FleetOperation,
              job.fleet.throughEnvironmentId,
              { organizationId: last.organizationId, environmentId: last.id },
              page.number + 1
            );
            const progress = job.operation === "migrate" ? job.fleet.pageProgress : job.progress;
            const fleet = {
              ...job.fleet,
              phase: "apply" as const,
              completedPages: job.fleet.completedPages + 1,
              completedEnvironments: job.fleet.completedEnvironments + page.environments.length,
              rewritten: job.fleet.rewritten + progress.rewritten,
              conflicts: job.fleet.conflicts + progress.conflicts,
              skippedEnvironments: job.fleet.skippedEnvironments + job.skippedEnvironments,
              pageProgress: emptyProgress(),
            };
            if (nextPage.environments.length) {
              const next = resetPageProgress(job);
              next.pageId = nextPage.id;
              next.fleet = {
                ...fleet,
                pageNumber: nextPage.number,
                pageSize: nextPage.environments.length,
              };
              await save(next, nextPage);
              return true;
            }
            await save({ ...job, fleet, status: "completed" });
            return false;
          }
        }
        if (job.status === "running") job.status = "completed";
      } catch (error) {
        const environment = page.environments[job.completedEnvironments];
        if (
          job.fleet &&
          environment &&
          job.currentEnvironment?.id === environment.id &&
          !(await this.options.db.runtimeEnvironment.findFirst({
            where: { id: environment.id },
            select: { id: true },
          }))
        ) {
          job.completedEnvironments++;
          job.skippedEnvironments++;
          job.progress = { ...job.completedProgress };
          await save();
          return true;
        }
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
      return false;
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
