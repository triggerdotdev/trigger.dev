import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { marqs } from "~/v3/marqs/index.server";
import { engine } from "~/v3/runEngine.server";
import { BasePresenter } from "./basePresenter.server";

export type Environment = {
  running: number;
  queued: number;
  concurrencyLimit: number;
};

export class EnvironmentQueuePresenter extends BasePresenter {
  async call(environment: AuthenticatedEnvironment): Promise<Environment> {
    //executing
    const engineV1Executing = await marqs.currentConcurrencyOfEnvironment(environment);
    const engineV2Executing = await engine.concurrencyOfEnvQueue(environment);
    const running = (engineV1Executing ?? 0) + (engineV2Executing ?? 0);

    //queued
    const engineV1Queued = await marqs.lengthOfEnvQueue(environment);
    const engineV2Queued = await engine.lengthOfEnvQueue(environment);
    const queued = (engineV1Queued ?? 0) + (engineV2Queued ?? 0);

    return {
      running,
      queued,
      concurrencyLimit: environment.maximumConcurrencyLimit,
    };
  }
}
