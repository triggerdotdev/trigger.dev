import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { DEFAULT_DEV_BRANCH } from "@trigger.dev/core/v3/utils/gitBranch";
import type { ResolvedConfig } from "@trigger.dev/core/v3/build";
import {
  createTaskMetadataFailedErrorStack,
  DuplicateTaskIdsError,
  TaskIndexingImportError,
  TaskMetadataParseError,
} from "@trigger.dev/core/v3/errors";
import type { TaskRunError } from "@trigger.dev/core/v3/schemas";
import { TaskRunErrorCodes } from "@trigger.dev/core/v3/schemas";
import type { DevCommandOptions } from "../commands/dev.js";
import {
  aiHelpLink,
  chalkError,
  chalkGrey,
  chalkLink,
  chalkRun,
  chalkSuccess,
  chalkTask,
  chalkWarning,
  chalkWorker,
  cliLink,
  isLinksSupported,
  prettyError,
  prettyPrintDate,
} from "../utilities/cliOutput.js";
import type { EventBusEventArgs } from "../utilities/eventBus.js";
import { eventBus } from "../utilities/eventBus.js";
import { logger } from "../utilities/logger.js";
import type { Socket } from "socket.io-client";
import { BundleError } from "../build/bundle.js";
import { analyzeWorker } from "../utilities/analyze.js";

export type DevOutputOptions = {
  name: string | undefined;
  branch?: string;
  dashboardUrl: string;
  config: ResolvedConfig;
  args: DevCommandOptions;
};

export function startDevOutput(options: DevOutputOptions) {
  const { branch, dashboardUrl, config } = options;

  const baseUrl = `${dashboardUrl}/projects/v3/${config.project}`;

  const rebuildStarted = (...[_target]: EventBusEventArgs<"rebuildStarted">) => {
    logger.log(chalkGrey("○ Rebuilding local worker…"));
  };

  const buildStarted = (...[_target]: EventBusEventArgs<"buildStarted">) => {
    logger.log(chalkGrey("○ Building local worker…"));
  };

  const buildFailed = (...[_target, error]: EventBusEventArgs<"buildFailed">) => {
    const errorText = error instanceof Error ? error.message : "Unknown error";
    const stack = error instanceof Error ? error.stack : undefined;

    let issues: string[] = [];

    if (error instanceof BundleError) {
      issues = error.issues?.map((issue) => `${issue.text} (${issue.location?.file})`) ?? [];
    }

    aiHelpLink({
      dashboardUrl,
      project: config.project,
      query: `Build failed:\n ${errorText}\n${issues.join("\n")}\n${stack}`,
    });
  };

  const workerSkipped = () => {
    logger.log(chalkGrey("○ No changes detected, skipping build…"));
  };

  const backgroundWorkerInitialized = (
    ...[worker]: EventBusEventArgs<"backgroundWorkerInitialized">
  ) => {
    analyzeWorker(worker, options.args.analyze, options.args.disableWarnings);

    const logParts: string[] = [];

    const testUrl = `${dashboardUrl}/projects/v3/${config.project}/test?environment=dev`;
    const runsUrl = `${dashboardUrl}/projects/v3/${config.project}/runs?envSlug=dev`;

    const pipe = chalkGrey("|");
    const bullet = chalkGrey("○");
    const arrow = chalkGrey("->");

    logParts.push(bullet);

    const testLink = chalkLink(cliLink("Test tasks", testUrl));
    const runsLink = chalkLink(cliLink("View runs", runsUrl));

    const runtime = chalkGrey(`[${worker.build.runtime}]`);
    const workerStarted = chalkGrey(
      `Local worker ready on branch: ${branch ?? DEFAULT_DEV_BRANCH}`
    );
    const workerVersion = chalkWorker(worker.serverWorker!.version);

    logParts.push(workerStarted, runtime, arrow, workerVersion);

    if (isLinksSupported) {
      logParts.push(pipe, testLink, pipe, runsLink);
    }

    logger.log(logParts.join(" "));
  };

  const backgroundWorkerIndexingError = (
    ...[_buildManifest, error]: EventBusEventArgs<"backgroundWorkerIndexingError">
  ) => {
    if (error instanceof TaskIndexingImportError) {
      let errorText = "";
      for (const importError of error.importErrors) {
        prettyError(
          `Could not import ${importError.file}`,
          importError.stack ?? importError.message
        );
        errorText += `Could not import ${importError.file}:\n ${
          importError.stack ?? importError.message
        }\n`;
      }

      aiHelpLink({ dashboardUrl, project: config.project, query: errorText });
    } else if (error instanceof TaskMetadataParseError) {
      const errorStack = createTaskMetadataFailedErrorStack({
        version: "v1",
        zodIssues: error.zodIssues,
        tasks: error.tasks,
      });

      prettyError(`Could not parse task metadata`, errorStack);
      aiHelpLink({
        dashboardUrl,
        project: config.project,
        query: `Could not parse task metadata:\n ${errorStack}`,
      });
    } else if (error instanceof DuplicateTaskIdsError) {
      const body = error.collisions
        .map(({ id, filePaths }) => {
          const distinct = Array.from(new Set(filePaths));

          return distinct.length === 1
            ? `${chalkTask(id)} was defined more than once in ${distinct[0]}`
            : `${chalkTask(id)} was defined in:\n${distinct.map((f) => `  ${f}`).join("\n")}`;
        })
        .join("\n\n");

      prettyError(
        "Duplicate task ids detected",
        `${body}\n\nTask ids must be unique across your project (including scheduled tasks). Please rename one of them.`,
        cliLink("View the task docs", "https://trigger.dev/docs/tasks/overview")
      );
      aiHelpLink({
        dashboardUrl,
        project: config.project,
        query: `Duplicate task ids: ${error.collisions.map((c) => c.id).join(", ")}`,
      });
    } else {
      const errorText = error instanceof Error ? error.message : "Unknown error";
      const stack = error instanceof Error ? error.stack : undefined;

      prettyError(`Build failed: ${errorText}`, stack);
      aiHelpLink({
        dashboardUrl,
        project: config.project,
        query: `Build failed:\n ${errorText}\n${stack}`,
      });
    }
  };

  const runStarted = (...[worker, execution]: EventBusEventArgs<"runStarted">) => {
    if (!worker.serverWorker) {
      return;
    }

    // ○ Mar 27 09:17:25.653 -> View logs | 20240326.20 | create-avatar | run_slufhjdfiv8ejnrkw9dsj.1
    const logsUrl = `${baseUrl}/runs/${execution.run.id}`;
    const pipe = chalkGrey("|");
    const bullet = chalkGrey("○");
    const link = chalkLink(cliLink("View logs", logsUrl));
    let timestampPrefix = chalkGrey(prettyPrintDate(execution.run.startedAt));
    const workerPrefix = chalkWorker(worker.serverWorker.version);
    const taskPrefix = chalkTask(execution.task.id);
    const runId = chalkRun(`${execution.run.id}.${execution.attempt.number}`);

    logger.log(
      `${bullet} ${timestampPrefix} ${chalkGrey("->")} ${
        isLinksSupported ? `${link} ${pipe}` : ""
      } ${workerPrefix} ${pipe} ${taskPrefix} ${pipe} ${runId}`
    );
  };

  const runCompleted = (
    ...[worker, execution, completion, durationMs]: EventBusEventArgs<"runCompleted">
  ) => {
    const retryingText = chalkGrey(
      !completion.ok && completion.skippedRetrying
        ? " (retrying skipped)"
        : !completion.ok && completion.retry !== undefined
          ? ` (retrying in ${completion.retry.delay}ms)`
          : ""
    );

    const resultText = !completion.ok
      ? completion.error.type === "INTERNAL_ERROR" &&
        (completion.error.code === TaskRunErrorCodes.TASK_EXECUTION_ABORTED ||
          completion.error.code === TaskRunErrorCodes.TASK_RUN_CANCELLED)
        ? chalkWarning("Cancelled")
        : `${chalkError("Error")}${retryingText}`
      : chalkSuccess("Success");

    const errorText = !completion.ok
      ? formatErrorLog(completion.error)
      : "retry" in completion
        ? `retry in ${completion.retry}ms`
        : "";

    const elapsedText = chalkGrey(
      `(${formatDurationMilliseconds(durationMs, { style: "short" })})`
    );

    const timestampPrefix = chalkGrey(prettyPrintDate());

    const logsUrl = `${baseUrl}/runs/${execution.run.id}`;
    const pipe = chalkGrey("|");
    const bullet = chalkGrey("○");
    const link = chalkLink(cliLink("View logs", logsUrl));

    const workerPrefix = chalkWorker(worker.serverWorker!.version);
    const taskPrefix = chalkTask(execution.task.id);
    const runId = chalkRun(`${execution.run.id}.${execution.attempt.number}`);

    logger.log(
      `${bullet} ${timestampPrefix} ${chalkGrey("->")} ${
        isLinksSupported ? `${link} ${pipe}` : ""
      } ${workerPrefix} ${pipe} ${taskPrefix} ${pipe} ${runId} ${pipe} ${resultText} ${elapsedText}${errorText}`
    );
  };

  const socketConnectionDisconnected = (reason: Socket.DisconnectReason) => {
    logger.log(chalkGrey(`○ Connection was lost: ${reason}`));
  };

  const socketConnectionReconnected = (_reason: string) => {
    logger.log(chalkGrey(`○ Connection was restored`));
  };

  eventBus.on("rebuildStarted", rebuildStarted);
  eventBus.on("buildStarted", buildStarted);
  eventBus.on("buildFailed", buildFailed);
  eventBus.on("workerSkipped", workerSkipped);
  eventBus.on("backgroundWorkerInitialized", backgroundWorkerInitialized);
  eventBus.on("runStarted", runStarted);
  eventBus.on("runCompleted", runCompleted);
  eventBus.on("backgroundWorkerIndexingError", backgroundWorkerIndexingError);
  eventBus.on("socketConnectionDisconnected", socketConnectionDisconnected);
  eventBus.on("socketConnectionReconnected", socketConnectionReconnected);

  return () => {
    eventBus.off("rebuildStarted", rebuildStarted);
    eventBus.off("buildStarted", buildStarted);
    eventBus.off("buildFailed", buildFailed);
    eventBus.off("workerSkipped", workerSkipped);
    eventBus.off("backgroundWorkerInitialized", backgroundWorkerInitialized);
    eventBus.off("runStarted", runStarted);
    eventBus.off("runCompleted", runCompleted);
    eventBus.off("backgroundWorkerIndexingError", backgroundWorkerIndexingError);
    eventBus.off("socketConnectionDisconnected", socketConnectionDisconnected);
    eventBus.off("socketConnectionReconnected", socketConnectionReconnected);
  };
}

function formatErrorLog(error: TaskRunError) {
  switch (error.type) {
    case "INTERNAL_ERROR": {
      return "";
    }
    case "STRING_ERROR": {
      return `\n\n${chalkError("X Error:")} ${error.raw}\n`;
    }
    case "CUSTOM_ERROR": {
      return `\n\n${chalkError("X Error:")} ${error.raw}\n`;
    }
    case "BUILT_IN_ERROR": {
      return `\n\n${error.stackTrace.replace(/^Error: /, chalkError("X Error: "))}\n`;
    }
  }
}
