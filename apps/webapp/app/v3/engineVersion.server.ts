import { RunEngineVersion, type RuntimeEnvironmentType } from "@trigger.dev/database";
import { $replica } from "~/db.server";
import {
  findCurrentWorkerFromEnvironment,
  getCurrentWorkerDeploymentEngineVersion,
} from "./models/workerDeployment.server";

type Environment = {
  id: string;
  type: RuntimeEnvironmentType;
  project: {
    id: string;
    engine: RunEngineVersion;
  };
};

export async function determineEngineVersion({
  environment,
  workerVersion,
  engineVersion: version,
}: {
  environment: Environment;
  workerVersion?: string;
  engineVersion?: RunEngineVersion;
}): Promise<RunEngineVersion> {
  if (version) {
    return version;
  }

  // If the project is V1, then none of the background workers are running V2
  if (environment.project.engine === RunEngineVersion.V1) {
    return "V1";
  }

  /**
   * The project has V2 enabled so it *could* be V2.
   */

  // A specific worker version is requested
  if (workerVersion) {
    const worker = await $replica.backgroundWorker.findUnique({
      select: {
        engine: true,
      },
      where: {
        projectId_runtimeEnvironmentId_version: {
          projectId: environment.project.id,
          runtimeEnvironmentId: environment.id,
          version: workerVersion,
        },
      },
    });

    if (!worker) {
      throw new Error(`Worker not found: environment: ${environment.id} version: ${workerVersion}`);
    }

    return worker.engine;
  }

  // Dev: use the latest BackgroundWorker
  if (environment.type === "DEVELOPMENT") {
    const backgroundWorker = await findCurrentWorkerFromEnvironment(environment);
    return backgroundWorker?.engine ?? "V1";
  }

  // Deployed: use the latest deployed BackgroundWorker
  const currentDeploymentEngineVersion = await getCurrentWorkerDeploymentEngineVersion(
    environment.id
  );
  if (currentDeploymentEngineVersion) {
    return currentDeploymentEngineVersion;
  }

  return environment.project.engine;
}
