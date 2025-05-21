import { promiseWithResolvers } from "@trigger.dev/core";

export class RaceSimulationSystem {
  private racepoints: Record<string, Promise<void> | undefined> = {};

  constructor() {}

  async waitForRacepoint({ runId }: { runId: string }): Promise<void> {
    if (this.racepoints[runId]) {
      return this.racepoints[runId];
    }

    return Promise.resolve();
  }

  registerRacepointForRun({ runId, waitInterval }: { runId: string; waitInterval: number }) {
    if (this.racepoints[runId]) {
      return;
    }

    const { promise, resolve } = promiseWithResolvers<void>();

    this.racepoints[runId] = promise;

    setTimeout(() => {
      resolve();
    }, waitInterval);

    promise.then(() => {
      delete this.racepoints[runId];
    });
  }
}
