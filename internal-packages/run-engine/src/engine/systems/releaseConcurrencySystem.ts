import { SystemResources } from "./systems.js";

export type ReleaseConcurrencySystemOptions = {
  resources: SystemResources;
};

export class ReleaseConcurrencySystem {
  private readonly $: SystemResources;

  constructor(private readonly options: ReleaseConcurrencySystemOptions) {
    this.$ = options.resources;
  }

  public async releaseConcurrency(
    run: {
      id: string;
      organizationId?: string | null;
      lockedQueueReleaseConcurrencyOnWaitpoint?: boolean | null;
    },
    forceReleaseConcurrency?: boolean
  ) {
    if (!run.organizationId) {
      this.$.logger.error(
        "ReleaseConcurrencySystem.releaseConcurrency(): Run organization ID is required",
        {
          runId: run.id,
        }
      );

      return;
    }

    if (typeof forceReleaseConcurrency === "boolean") {
      if (forceReleaseConcurrency) {
        await this.$.runQueue.releaseAllConcurrency(run.organizationId, run.id);

        return;
      }

      await this.$.runQueue.releaseEnvConcurrency(run.organizationId, run.id);

      return;
    }

    if (run.lockedQueueReleaseConcurrencyOnWaitpoint) {
      await this.$.runQueue.releaseAllConcurrency(run.organizationId, run.id);

      return;
    }

    await this.$.runQueue.releaseEnvConcurrency(run.organizationId, run.id);

    return;
  }
}
