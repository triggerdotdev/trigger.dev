import { signalsEmitter } from "~/services/signals.server";
import { Pool } from "pg";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { type RuntimeEnvironmentType, type WorkerDeploymentStatus } from "@trigger.dev/database";
import { type PrismaClient, prisma } from "~/db.server";
import { triggerInitialDeployment } from "~/services/platform.v3.server";
import { atomicProductionDeploymentUrl } from "./atomicProductionDeployment.server";

export type DeployNowResult =
  | { ok: true }
  | { ok: false; reason: "atomicProduction"; vercelUrl: string }
  | { ok: false; reason: "alreadyInFlight" | "unsupportedEnvironment" | "error" };

const NON_TERMINAL_STATUSES: WorkerDeploymentStatus[] = [
  "PENDING",
  "INSTALLING",
  "BUILDING",
  "DEPLOYING",
];

function mapEnvironmentType(
  type: RuntimeEnvironmentType
): "prod" | "staging" | "preview" | undefined {
  switch (type) {
    case "PRODUCTION":
      return "prod";
    case "STAGING":
      return "staging";
    case "PREVIEW":
      return "preview";
    default:
      return undefined;
  }
}

export class TriggerDeployNowService {
  #trigger: typeof triggerInitialDeployment;
  #prisma: PrismaClient;
  #lockPool: Pool;

  constructor();
  constructor(
    triggerFn: typeof triggerInitialDeployment,
    prismaClient: PrismaClient,
    lockPool: Pool
  );
  constructor(
    triggerFn: typeof triggerInitialDeployment = triggerInitialDeployment,
    prismaClient: PrismaClient = prisma,
    lockPool?: Pool
  ) {
    this.#trigger = triggerFn;
    this.#prisma = prismaClient;
    if (prismaClient !== prisma && !lockPool) {
      throw new Error("An injected Prisma client requires its matching deployment lock pool");
    }
    this.#lockPool =
      lockPool ??
      singleton("deployNowLockPool", () => {
        const pool = new Pool({
          connectionString: env.CONTROL_PLANE_DATABASE_URL ?? env.DATABASE_URL,
          max: 3,
          connectionTimeoutMillis: 5_000,
        });
        pool.on("error", (error) => logger.error("Deploy now lock connection failed", { error }));
        let closing = false;
        const close = () => {
          if (closing) return;
          closing = true;
          void pool
            .end()
            .catch((error) => logger.error("Deploy now lock pool shutdown failed", { error }));
        };
        signalsEmitter.once("SIGTERM", close);
        signalsEmitter.once("SIGINT", close);
        return pool;
      });
  }

  async call(opts: {
    projectId: string;
    environmentId: string;
    environmentType: RuntimeEnvironmentType;
    branch: string;
  }): Promise<DeployNowResult> {
    try {
      return await this.#call(opts);
    } catch (error) {
      logger.error("Deploy now failed", {
        error,
        projectId: opts.projectId,
        environmentId: opts.environmentId,
      });
      return { ok: false, reason: "error" };
    }
  }

  async #call(opts: {
    projectId: string;
    environmentId: string;
    environmentType: RuntimeEnvironmentType;
    branch: string;
  }): Promise<DeployNowResult> {
    const environment = mapEnvironmentType(opts.environmentType);
    if (!environment) {
      return { ok: false, reason: "unsupportedEnvironment" };
    }

    const vercelUrl = await atomicProductionDeploymentUrl(
      opts.projectId,
      opts.environmentType,
      this.#prisma
    );
    if (vercelUrl) return { ok: false, reason: "atomicProduction", vercelUrl };

    // Use a dedicated transaction connection rather than Prisma's timed interactive
    // transaction: its timeout could release the lock while the HTTP call continues.
    const lockStartedAt = performance.now();
    const connection = await this.#lockPool.connect();
    let destroyConnection = false;
    const onConnectionError = (error: Error) => {
      destroyConnection = true;
      logger.error("Deploy now lock connection lost", { error, environmentId: opts.environmentId });
    };
    connection.on("error", onConnectionError);
    try {
      await connection.query("BEGIN");
      const {
        rows: [lock],
      } = await connection.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('trigger-deploy-now:' || $1, 0)) AS acquired",
        [opts.environmentId]
      );
      logger.debug("Deploy now lock acquisition", {
        environmentId: opts.environmentId,
        acquired: lock?.acquired ?? false,
        durationMs: performance.now() - lockStartedAt,
      });
      if (!lock?.acquired) return { ok: false, reason: "alreadyInFlight" };

      // Read from primary after taking the lock. The platform persists a deployment
      // before responding, so the next caller observes it after this lock releases.
      const inFlight = await this.#prisma.workerDeployment.findFirst({
        where: {
          environmentId: opts.environmentId,
          // oxlint-disable-next-line trigger-prisma/no-unbounded-list-filter -- Fixed four deployment statuses; the bind-parameter count cannot grow with input.
          status: { in: NON_TERMINAL_STATUSES },
        },
        select: { id: true },
      });
      if (inFlight) return { ok: false, reason: "alreadyInFlight" };

      if (destroyConnection) return { ok: false, reason: "error" };
      const result = await this.#trigger(opts.projectId, { environment, branch: opts.branch });
      return result.ok ? { ok: true } : { ok: false, reason: "error" };
    } finally {
      try {
        await connection.query("ROLLBACK");
      } catch {
        destroyConnection = true;
      }
      connection.removeListener("error", onConnectionError);
      connection.release(destroyConnection);
    }
  }
}
