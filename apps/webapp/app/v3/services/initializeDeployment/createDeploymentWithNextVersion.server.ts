import {
  isUniqueConstraintError,
  type Prisma,
  type PrismaClientOrTransaction,
  type WorkerDeployment,
} from "@trigger.dev/database";
import { setTimeout as sleep } from "node:timers/promises";
import { logger } from "~/services/logger.server";
import { calculateNextBuildVersion } from "../../utils/calculateNextBuildVersion";

export type CreateDeploymentData = Omit<
  Prisma.WorkerDeploymentUncheckedCreateInput,
  "version" | "environmentId"
>;

export type CreateDeploymentWithNextVersionOptions = {
  maxRetries?: number;
  jitterMs?: { min: number; max: number };
};

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_JITTER_MS = { min: 5, max: 50 };

export class DeploymentVersionCollisionError extends Error {
  readonly name = "DeploymentVersionCollisionError";
  readonly environmentId: string;
  readonly attempts: number;
  readonly lastAttemptedVersion: string;

  constructor(args: {
    environmentId: string;
    attempts: number;
    lastAttemptedVersion: string;
    cause: unknown;
  }) {
    super(
      `Failed to allocate a unique worker deployment version for environment ${args.environmentId} after ${args.attempts} attempt(s); last tried "${args.lastAttemptedVersion}"`,
      { cause: args.cause }
    );
    this.environmentId = args.environmentId;
    this.attempts = args.attempts;
    this.lastAttemptedVersion = args.lastAttemptedVersion;
  }
}

export async function createDeploymentWithNextVersion(
  prisma: PrismaClientOrTransaction,
  environmentId: string,
  buildData: (nextVersion: string) => CreateDeploymentData | Promise<CreateDeploymentData>,
  options: CreateDeploymentWithNextVersionOptions = {}
): Promise<WorkerDeployment> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const jitterMs = options.jitterMs ?? DEFAULT_JITTER_MS;

  let lastError: unknown;
  let lastVersion = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const latest = await prisma.workerDeployment.findFirst({
      where: { environmentId },
      orderBy: { createdAt: "desc" },
      take: 1,
    });

    const version = calculateNextBuildVersion(latest?.version);
    lastVersion = version;
    const data = await buildData(version);

    try {
      return await prisma.workerDeployment.create({
        data: { ...data, environmentId, version },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error, ["environmentId", "version"])) {
        throw error;
      }

      lastError = error;
      logger.warn("Worker deployment version collided, retrying", {
        environmentId,
        attempt: attempt + 1,
        maxRetries,
        attemptedVersion: version,
      });

      // Randomised backoff so N concurrent racers don't loop in lockstep into the
      // same collision again.
      const delay = jitterMs.min + Math.random() * (jitterMs.max - jitterMs.min);
      await sleep(delay);
    }
  }

  throw new DeploymentVersionCollisionError({
    environmentId,
    attempts: maxRetries + 1,
    lastAttemptedVersion: lastVersion,
    cause: lastError,
  });
}
