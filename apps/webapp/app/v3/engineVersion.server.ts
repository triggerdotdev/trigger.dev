import { RunEngineVersion, RuntimeEnvironmentType } from "@trigger.dev/database";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";

export async function determineEngineVersion({
  environment,
  version,
}: {
  environment: AuthenticatedEnvironment;
  version?: RunEngineVersion;
}): Promise<RunEngineVersion> {
  if (version) return version;

  // If the project is V1, then none of the background workers are running V2
  if (environment.project.engine === RunEngineVersion.V1) {
    return "V1";
  }

  // For now, dev is always V1
  if (environment.type === RuntimeEnvironmentType.DEVELOPMENT) {
    return "V1";
  }

  //todo we need to determine the version using the BackgroundWorker
  //- triggerAndWait we can lookup the BackgroundWorker easily, and get the engine.
  //- No locked version: lookup the BackgroundWorker via the Deployment/latest dev BW
  // const workerWithTasks = workerId
  //   ? await getWorkerDeploymentFromWorker(prisma, workerId)
  //   : run.runtimeEnvironment.type === "DEVELOPMENT"
  //   ? await getMostRecentWorker(prisma, run.runtimeEnvironmentId)
  //   : await getWorkerFromCurrentlyPromotedDeployment(prisma, run.runtimeEnvironmentId);

  //todo Additional checks
  /*
  - If the `triggerVersion` is 3.2 or higher AND the project has engine V2, we will use the run engine.
  - Add an `engine` column to `Project` in the database.

  Add `engine` to the trigger.config file. It would default to "V1" for now, but you can set it to V2.

  You run `npx trigger.dev@latest deploy` with config v2.
  - Create BackgroundWorker with `engine`: `v2`.
  - Set the `project` `engine` column to `v2`.

  You run `npx trigger.dev@latest dev`  with config v2
  - Create BackgroundWorker with `engine`: `v2`.
  - Set the `project` `engine` column to `v2`.

  When triggering
  - triggerAndWait we can lookup the BackgroundWorker easily, and get the engine.
  - No locked version: lookup the BackgroundWorker via the Deployment/latest dev BW
  */

  return "V2";
}
