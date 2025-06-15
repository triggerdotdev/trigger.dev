import { TaskRunExecutionSnapshot } from "@trigger.dev/database";
import { z } from "zod";
import {
  ReleaseConcurrencyQueueOptions,
  ReleaseConcurrencyTokenBucketQueue,
} from "../releaseConcurrencyTokenBucketQueue.js";
import { canReleaseConcurrency } from "../statuses.js";
import { getLatestExecutionSnapshot } from "./executionSnapshotSystem.js";
import { SystemResources } from "./systems.js";

const ReleaseConcurrencyMetadata = z.object({
  releaseConcurrency: z.boolean().optional(),
});

type ReleaseConcurrencyMetadata = z.infer<typeof ReleaseConcurrencyMetadata>;

export type ReleaseConcurrencySystemOptions = {
  resources: SystemResources;
  maxTokensRatio?: number;
  releasingsMaxAge?: number;
  releasingsPollInterval?: number;
  queueOptions?: Omit<
    ReleaseConcurrencyQueueOptions<{
      orgId: string;
      projectId: string;
      envId: string;
    }>,
    "executor" | "validateReleaserId" | "keys" | "maxTokens"
  >;
};

export class ReleaseConcurrencySystem {
  private readonly $: SystemResources;
  releaseConcurrencyQueue?: ReleaseConcurrencyTokenBucketQueue<{
    orgId: string;
    projectId: string;
    envId: string;
  }>;

  constructor(private readonly options: ReleaseConcurrencySystemOptions) {
    this.$ = options.resources;

    if (options.queueOptions) {
      this.releaseConcurrencyQueue = new ReleaseConcurrencyTokenBucketQueue({
        ...options.queueOptions,
        releasingsMaxAge: this.options.releasingsMaxAge,
        releasingsPollInterval: this.options.releasingsPollInterval,
        executor: async (descriptor, snapshotId) => {
          return await this.executeReleaseConcurrencyForSnapshot(snapshotId);
        },
        keys: {
          fromDescriptor: (descriptor) =>
            `org:${descriptor.orgId}:proj:${descriptor.projectId}:env:${descriptor.envId}`,
          toDescriptor: (name) => ({
            orgId: name.split(":")[1],
            projectId: name.split(":")[3],
            envId: name.split(":")[5],
          }),
        },
        maxTokens: async (descriptor) => {
          const environment = await this.$.prisma.runtimeEnvironment.findFirstOrThrow({
            where: { id: descriptor.envId },
            select: {
              maximumConcurrencyLimit: true,
            },
          });

          return environment.maximumConcurrencyLimit * (this.options.maxTokensRatio ?? 1.0);
        },
        validateReleaserId: async (releaserId) => {
          return this.validateSnapshotShouldRefillToken(releaserId);
        },
      });
    }
  }

  async validateSnapshotShouldRefillToken(releaserId: string) {
    const snapshot = await this.$.prisma.taskRunExecutionSnapshot.findFirst({
      where: { id: releaserId },
      select: {
        id: true,
        run: {
          select: {
            id: true,
            status: true,
          },
        },
        organizationId: true,
        projectId: true,
        environmentId: true,
        executionStatus: true,
      },
    });

    if (!snapshot) {
      return;
    }

    const latestSnapshot = await getLatestExecutionSnapshot(this.$.prisma, snapshot.run.id);

    this.$.logger.debug("Checking if snapshot should refill", {
      snapshot,
      latestSnapshot,
    });

    return {
      releaseQueue: {
        orgId: snapshot.organizationId,
        projectId: snapshot.projectId,
        envId: snapshot.environmentId,
      },
      releaserId: snapshot.id,
      shouldRefill: latestSnapshot.id !== snapshot.id,
    };
  }

  public async consumeToken(
    descriptor: { orgId: string; projectId: string; envId: string },
    releaserId: string
  ) {
    if (!this.releaseConcurrencyQueue) {
      return;
    }

    await this.releaseConcurrencyQueue.consumeToken(descriptor, releaserId);
  }

  /**
   * This is used in tests only
   */
  public async returnToken(
    descriptor: { orgId: string; projectId: string; envId: string },
    releaserId: string
  ) {
    if (!this.releaseConcurrencyQueue) {
      return;
    }

    await this.releaseConcurrencyQueue.returnToken(descriptor, releaserId);
  }

  public async quit() {
    if (!this.releaseConcurrencyQueue) {
      return;
    }

    await this.releaseConcurrencyQueue.quit();
  }

  public async refillTokensForSnapshot(snapshotId: string | undefined): Promise<void>;
  public async refillTokensForSnapshot(snapshot: TaskRunExecutionSnapshot): Promise<void>;
  public async refillTokensForSnapshot(
    snapshotOrId: TaskRunExecutionSnapshot | string | undefined
  ) {
    if (!this.releaseConcurrencyQueue) {
      return;
    }

    if (typeof snapshotOrId === "undefined") {
      return;
    }

    const snapshot =
      typeof snapshotOrId === "string"
        ? await this.$.prisma.taskRunExecutionSnapshot.findFirst({
            where: { id: snapshotOrId },
          })
        : snapshotOrId;

    if (!snapshot) {
      this.$.logger.error("Snapshot not found", {
        snapshotId: snapshotOrId,
      });

      return;
    }

    if (snapshot.executionStatus !== "EXECUTING_WITH_WAITPOINTS") {
      this.$.logger.debug("Snapshot is not in a valid state to refill tokens", {
        snapshot,
      });

      return;
    }

    await this.releaseConcurrencyQueue.refillTokenIfInReleasings(
      {
        orgId: snapshot.organizationId,
        projectId: snapshot.projectId,
        envId: snapshot.environmentId,
      },
      snapshot.id
    );
  }

  public async releaseConcurrencyForSnapshot(snapshot: TaskRunExecutionSnapshot) {
    if (!this.releaseConcurrencyQueue) {
      this.$.logger.debug("Release concurrency queue not enabled, skipping release", {
        snapshotId: snapshot.id,
      });

      return;
    }

    // Go ahead and release concurrency immediately if the run is in a development environment
    if (snapshot.environmentType === "DEVELOPMENT") {
      this.$.logger.debug("Immediate release of concurrency for development environment", {
        snapshotId: snapshot.id,
      });

      return await this.executeReleaseConcurrencyForSnapshot(snapshot.id);
    }

    await this.releaseConcurrencyQueue.attemptToRelease(
      {
        orgId: snapshot.organizationId,
        projectId: snapshot.projectId,
        envId: snapshot.environmentId,
      },
      snapshot.id
    );
  }

  public async executeReleaseConcurrencyForSnapshot(snapshotId: string): Promise<boolean> {
    if (!this.releaseConcurrencyQueue) {
      return false;
    }

    this.$.logger.debug("Executing released concurrency", {
      snapshotId,
    });

    // Fetch the snapshot
    const snapshot = await this.$.prisma.taskRunExecutionSnapshot.findFirst({
      where: { id: snapshotId },
      select: {
        id: true,
        previousSnapshotId: true,
        executionStatus: true,
        organizationId: true,
        metadata: true,
        runId: true,
        run: {
          select: {
            lockedQueueId: true,
          },
        },
      },
    });

    if (!snapshot) {
      this.$.logger.error("Snapshot not found", {
        snapshotId,
      });

      return false;
    }

    // - Runlock the run
    // - Get latest snapshot
    // - If the run is non suspended or going to be, then bail
    // - If the run is suspended or going to be, then release the concurrency
    return await this.$.runLock.lock(
      "executeReleaseConcurrencyForSnapshot",
      [snapshot.runId],
      async () => {
        const latestSnapshot = await getLatestExecutionSnapshot(this.$.prisma, snapshot.runId);

        const isValidSnapshot =
          latestSnapshot.id === snapshot.id ||
          // Case 2: The provided snapshotId matches the previous snapshot
          // AND we're in SUSPENDED state (which is valid)
          (latestSnapshot.previousSnapshotId === snapshot.id &&
            latestSnapshot.executionStatus === "SUSPENDED");

        if (!isValidSnapshot) {
          this.$.logger.error("Tried to release concurrency on an invalid snapshot", {
            latestSnapshot,
            snapshot,
          });

          return false;
        }

        if (!canReleaseConcurrency(latestSnapshot.executionStatus)) {
          this.$.logger.debug("Run is not in a state to release concurrency", {
            runId: snapshot.runId,
            snapshot: latestSnapshot,
          });

          return false;
        }

        const metadata = this.#parseMetadata(snapshot.metadata);

        if (typeof metadata.releaseConcurrency === "boolean") {
          if (metadata.releaseConcurrency) {
            await this.$.runQueue.releaseAllConcurrency(snapshot.organizationId, snapshot.runId);

            return true;
          }

          await this.$.runQueue.releaseEnvConcurrency(snapshot.organizationId, snapshot.runId);

          return true;
        }

        // Get the locked queue
        const taskQueue = snapshot.run.lockedQueueId
          ? await this.$.prisma.taskQueue.findFirst({
              where: {
                id: snapshot.run.lockedQueueId,
              },
            })
          : undefined;

        if (
          taskQueue &&
          (typeof taskQueue.concurrencyLimit === "undefined" ||
            taskQueue.releaseConcurrencyOnWaitpoint)
        ) {
          await this.$.runQueue.releaseAllConcurrency(snapshot.organizationId, snapshot.runId);

          return true;
        }

        await this.$.runQueue.releaseEnvConcurrency(snapshot.organizationId, snapshot.runId);

        return true;
      }
    );
  }

  #parseMetadata(metadata?: unknown): ReleaseConcurrencyMetadata {
    if (!metadata) {
      return {};
    }

    const result = ReleaseConcurrencyMetadata.safeParse(metadata);

    if (!result.success) {
      return {};
    }

    return result.data;
  }
}
