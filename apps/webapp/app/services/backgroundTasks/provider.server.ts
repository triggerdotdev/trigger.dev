import { BackgroundTask, BackgroundTaskProviderStrategy } from "@trigger.dev/database";
import { env } from "~/env.server";
import { FlyBackgroundTaskProvider } from "./providers/fly.server";
import { BackgroundTaskProvider, ExternalMachine, ExternalMachineConfig } from "./providers/types";

export class UnsupportedBackgroundTaskProvider implements BackgroundTaskProvider {
  async prepareArtifact(task: BackgroundTask): Promise<any> {
    throw new Error("Unsupported background task provider");
  }

  get name(): BackgroundTaskProviderStrategy {
    return "UNSUPPORTED";
  }

  get defaultRegion(): string {
    return "UNSUPPORTED";
  }

  get registry(): string {
    return "UNSUPPORTED";
  }

  async getMachineForTask(id: string, task: BackgroundTask): Promise<ExternalMachine | undefined> {
    throw new Error("Unsupported background task provider");
  }

  getMachinesForTask(task: BackgroundTask): Promise<Array<ExternalMachine>> {
    throw new Error("Unsupported background task provider");
  }

  createMachineForTask(
    id: string,
    task: BackgroundTask,
    config: ExternalMachineConfig
  ): Promise<ExternalMachine> {
    throw new Error("Unsupported background task provider");
  }

  cleanupForTask(task: BackgroundTask): Promise<void> {
    throw new Error("Unsupported background task provider");
  }
}

let backgroundTaskProvider: BackgroundTaskProvider;

if (env.FLY_IO_API_TOKEN && env.FLY_IO_API_URL && env.FLY_IO_ORG_SLUG) {
  backgroundTaskProvider = new FlyBackgroundTaskProvider(
    env.FLY_IO_API_URL,
    env.FLY_IO_ORG_SLUG,
    env.FLY_IO_API_TOKEN
  );
} else {
  backgroundTaskProvider = new UnsupportedBackgroundTaskProvider();
}

export { backgroundTaskProvider };
