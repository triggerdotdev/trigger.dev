import { ResolvedConfig } from "@trigger.dev/core/v3/build";
import { DevCommandOptions } from "../commands/dev.js";
import { logger } from "../utilities/logger.js";
import { chalkGrey, chalkLink, chalkWorker, cliLink } from "../utilities/cliOutput.js";
import { eventBus, EventBusEventArgs } from "../utilities/eventBus.js";

export type DevOutputOptions = {
  name: string | undefined;
  dashboardUrl: string;
  config: ResolvedConfig;
  args: DevCommandOptions;
};

export function startDevOutput(options: DevOutputOptions) {
  const { dashboardUrl, config } = options;

  const rebuildStarted = (...[target]: EventBusEventArgs<"rebuildStarted">) => {
    logger.log(chalkGrey("○ Rebuilding background worker…"));
  };

  const buildStarted = (...[target]: EventBusEventArgs<"buildStarted">) => {
    logger.log(chalkGrey("○ Building background worker…"));
  };

  const workerSkipped = () => {
    logger.log(chalkGrey("○ No changes detected, skipping build…"));
  };

  const backgroundWorkerInitialized = (
    ...[worker]: EventBusEventArgs<"backgroundWorkerInitialized">
  ) => {
    const testUrl = `${dashboardUrl}/projects/v3/${config.project}/test?environment=dev`;
    const runsUrl = `${dashboardUrl}/projects/v3/${config.project}/runs?envSlug=dev`;

    const pipe = chalkGrey("|");
    const bullet = chalkGrey("○");
    const arrow = chalkGrey("->");

    const testLink = chalkLink(cliLink("Test tasks", testUrl));
    const runsLink = chalkLink(cliLink("View runs", runsUrl));

    const workerStarted = chalkGrey("Background worker started");
    const workerVersion = chalkWorker(worker.serverWorker!.version);

    logger.log(
      `${bullet} ${workerStarted} ${arrow} ${workerVersion} ${pipe} ${testLink} ${pipe} ${runsLink}`
    );
  };

  eventBus.on("rebuildStarted", rebuildStarted);
  eventBus.on("buildStarted", buildStarted);
  eventBus.on("workerSkipped", workerSkipped);
  eventBus.on("backgroundWorkerInitialized", backgroundWorkerInitialized);

  return () => {
    eventBus.off("rebuildStarted", rebuildStarted);
    eventBus.off("buildStarted", buildStarted);
    eventBus.off("workerSkipped", workerSkipped);
    eventBus.off("backgroundWorkerInitialized", backgroundWorkerInitialized);
  };
}
