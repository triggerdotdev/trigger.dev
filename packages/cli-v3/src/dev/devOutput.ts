import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { DEFAULT_DEV_BRANCH } from "@trigger.dev/core/v3/utils/gitBranch";
import type { ResolvedConfig } from "@trigger.dev/core/v3/build";
import {
  createTaskMetadataFailedErrorStack,
  DuplicateTaskIdsError,
  formatErrorCauses,
  TaskIndexingImportError,
  TaskMetadataParseError,
  taskRunErrorEnhancer,
  taskRunErrorToString,
} from "@trigger.dev/core/v3/errors";
import type { TaskRunError } from "@trigger.dev/core/v3/schemas";
import { TaskRunErrorCodes } from "@trigger.dev/core/v3/schemas";
import type { DevCommandOptions } from "../commands/dev.js";
import { isAgent } from "../utilities/agent.js";
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
  prettyWarning,
} from "../utilities/cliOutput.js";
import type { EventBusEventArgs } from "../utilities/eventBus.js";
import { eventBus } from "../utilities/eventBus.js";
import { logger } from "../utilities/logger.js";
import { formatScheduleWarnings } from "../utilities/scheduleWarnings.js";
import type { Socket } from "socket.io-client";
import { BundleError } from "../build/bundle.js";
import type { BackgroundWorker } from "./backgroundWorker.js";
import { analyzeWorker } from "../utilities/analyze.js";
import { SCHEDULE_PLAN_LIMIT_HEADER, SchedulePlanLimitError } from "./errors.js";

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

  // The version new runs execute on. A failed build leaves the previous worker running.
  let workerVersion: string | undefined;
  let printedAgentLinks = false;

  // A person can follow this link to the dashboard's AI help. An agent already has the error.
  const askAiForHelp = (query: string) => {
    if (!isAgent) {
      aiHelpLink({ dashboardUrl, project: config.project, query });
    }
  };

  const logBuildFailed = (willRebuild: boolean) => {
    const bullet = chalkError("○");
    const failed = chalkError("Build failed");

    if (!willRebuild) {
      logger.log(`${bullet} ${failed}${chalkGrey(". Fix the errors above and run dev again.")}`);
      return;
    }

    const runsText = workerVersion ? `, runs still use ${workerVersion}` : "";

    logger.log(
      `${bullet} ${failed}${chalkGrey(
        `${runsText}. Fix the errors above and it will rebuild automatically.`
      )}`
    );
  };

  const rebuildStarted = (...[target]: EventBusEventArgs<"rebuildStarted">) => {
    logger.log(chalkGrey("○ Rebuilding local worker…"));
  };

  const buildStarted = (...[target]: EventBusEventArgs<"buildStarted">) => {
    logger.log(chalkGrey("○ Building local worker…"));
  };

  const buildFailed = (...[target, error]: EventBusEventArgs<"buildFailed">) => {
    const errorText = error instanceof Error ? error.message : "Unknown error";
    const stack = error instanceof Error ? error.stack : undefined;

    let issues: string[] = [];

    if (error instanceof BundleError) {
      issues = error.issues?.map((issue) => `${issue.text} (${issue.location?.file})`) ?? [];
    }

    askAiForHelp(`Build failed:\n ${errorText}\n${issues.join("\n")}\n${stack}`);

    // Only the first build emits this, and the dev command exits after it
    logBuildFailed(false);
  };

  const rebuildFailed = () => {
    logBuildFailed(true);
  };

  const workerSkipped = () => {
    logger.log(
      chalkGrey(
        workerVersion
          ? `○ No changes detected, keeping local worker ${workerVersion}`
          : "○ No changes detected, skipping build…"
      )
    );
  };

  const backgroundWorkerInitialized = (
    ...[worker]: EventBusEventArgs<"backgroundWorkerInitialized">
  ) => {
    analyzeWorker(worker, options.args.analyze, options.args.disableWarnings);

    if (!options.args.disableWarnings && worker.warnings.length > 0) {
      prettyWarning("Schedule policy applied", formatScheduleWarnings(worker.warnings));
    }

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
    workerVersion = worker.serverWorker!.version;

    logParts.push(workerStarted, runtime, arrow, chalkWorker(workerVersion));

    if (isLinksSupported && !isAgent) {
      logParts.push(pipe, testLink, pipe, runsLink);
    }

    logger.log(logParts.join(" "));

    if (isAgent) {
      logAgentWorkerDetails(worker, { testUrl, runsUrl, includeLinks: !printedAgentLinks });
      printedAgentLinks = true;
    }
  };

  const backgroundWorkerIndexingError = (
    ...[buildManifest, error]: EventBusEventArgs<"backgroundWorkerIndexingError">
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

      askAiForHelp(errorText);
    } else if (error instanceof TaskMetadataParseError) {
      const errorStack = createTaskMetadataFailedErrorStack({
        version: "v1",
        zodIssues: error.zodIssues,
        tasks: error.tasks,
      });

      prettyError(`Could not parse task metadata`, errorStack);
      askAiForHelp(`Could not parse task metadata:\n ${errorStack}`);
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
      askAiForHelp(`Duplicate task ids: ${error.collisions.map((c) => c.id).join(", ")}`);
    } else if (error instanceof SchedulePlanLimitError) {
      prettyError(SCHEDULE_PLAN_LIMIT_HEADER, error.message);
      // The dev command exits after this error, so there's no rebuild to wait for
      return;
    } else {
      const errorText = error instanceof Error ? error.message : "Unknown error";
      const stack = error instanceof Error ? error.stack : undefined;

      prettyError(`Build failed: ${errorText}`, stack);
      askAiForHelp(`Build failed:\n ${errorText}\n${stack}`);
    }

    logBuildFailed(true);
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
    const timestampPrefix = chalkGrey(prettyPrintDate(execution.attempt.startedAt));
    const workerPrefix = chalkWorker(worker.serverWorker.version);
    const taskPrefix = chalkTask(execution.task.id);
    const runId = chalkRun(`${execution.run.id}.${execution.attempt.number}`);

    const logParts = [bullet, timestampPrefix, chalkGrey("->")];

    if (isLinksSupported && !isAgent) {
      logParts.push(link, pipe);
    }

    logParts.push(workerPrefix, pipe, taskPrefix, pipe, runId);

    if (isAgent) {
      logParts.push(pipe, logsUrl);
    }

    logger.log(logParts.join(" "));
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

    const logParts = [bullet, timestampPrefix, chalkGrey("->")];

    if (isLinksSupported && !isAgent) {
      logParts.push(link, pipe);
    }

    logParts.push(workerPrefix, pipe, taskPrefix, pipe, runId, pipe, resultText);

    logger.log(`${logParts.join(" ")} ${elapsedText}${errorText}`);

    if (isAgent && completion.ok) {
      const output = formatRunOutput(completion.output, completion.outputType);

      if (output !== undefined) {
        logger.log(`${chalkGrey("  Output:")} ${output}`);
      }
    }
  };

  const socketConnectionDisconnected = (reason: Socket.DisconnectReason) => {
    logger.log(chalkGrey(`○ Connection was lost: ${reason}`));
  };

  const socketConnectionReconnected = (reason: string) => {
    logger.log(chalkGrey(`○ Connection was restored`));
  };

  eventBus.on("rebuildStarted", rebuildStarted);
  eventBus.on("buildStarted", buildStarted);
  eventBus.on("buildFailed", buildFailed);
  eventBus.on("rebuildFailed", rebuildFailed);
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
    eventBus.off("rebuildFailed", rebuildFailed);
    eventBus.off("workerSkipped", workerSkipped);
    eventBus.off("backgroundWorkerInitialized", backgroundWorkerInitialized);
    eventBus.off("runStarted", runStarted);
    eventBus.off("runCompleted", runCompleted);
    eventBus.off("backgroundWorkerIndexingError", backgroundWorkerIndexingError);
    eventBus.off("socketConnectionDisconnected", socketConnectionDisconnected);
    eventBus.off("socketConnectionReconnected", socketConnectionReconnected);
  };
}

const MAX_AGENT_TASK_IDS = 50;
const MAX_AGENT_OUTPUT_LENGTH = 1_000;

// Agents can't click terminal links or open the dashboard, so they get the task ids and plain URLs
function logAgentWorkerDetails(
  worker: BackgroundWorker,
  { testUrl, runsUrl, includeLinks }: { testUrl: string; runsUrl: string; includeLinks: boolean }
) {
  const taskIds = worker.manifest?.tasks.map((task) => task.id) ?? [];
  const shownTaskIds = taskIds.slice(0, MAX_AGENT_TASK_IDS);
  const hiddenCount = taskIds.length - shownTaskIds.length;

  logger.log(
    chalkGrey(
      `  Tasks: ${shownTaskIds.length > 0 ? shownTaskIds.join(", ") : "none"}${
        hiddenCount > 0 ? `, and ${hiddenCount} more` : ""
      }`
    )
  );

  if (includeLinks) {
    logger.log(chalkGrey(`  Test tasks: ${testUrl}`));
    logger.log(chalkGrey(`  View runs: ${runsUrl}`));
  }
}

/** A run's output as one line, or undefined when the run didn't return anything. */
export function formatRunOutput(
  output: string | undefined,
  outputType: string
): string | undefined {
  if (output === undefined) {
    return undefined;
  }

  if (outputType === "application/store") {
    return "(too large to show here, view it in the dashboard)";
  }

  let text = output;

  if (outputType === "application/super+json") {
    try {
      // Show the plain JSON part, without superjson's type metadata
      text = JSON.stringify(JSON.parse(output).json);
    } catch {
      // Show the raw output
    }
  }

  if (text.length <= MAX_AGENT_OUTPUT_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_AGENT_OUTPUT_LENGTH)}… (${
    text.length - MAX_AGENT_OUTPUT_LENGTH
  } more characters)`;
}

function formatErrorLog(error: TaskRunError) {
  switch (error.type) {
    case "INTERNAL_ERROR": {
      // Already labelled "Cancelled"
      if (
        error.code === TaskRunErrorCodes.TASK_EXECUTION_ABORTED ||
        error.code === TaskRunErrorCodes.TASK_RUN_CANCELLED
      ) {
        return "";
      }

      const enhancedError = taskRunErrorEnhancer(error);
      const link = enhancedError.link
        ? `\n${enhancedError.link.name}: ${enhancedError.link.href}`
        : "";
      const stackTrace = error.stackTrace ? `\n${error.stackTrace}` : "";

      return `\n\n${chalkError("X Error:")} ${taskRunErrorToString(enhancedError)}${link}${stackTrace}\n`;
    }
    case "STRING_ERROR": {
      return `\n\n${chalkError("X Error:")} ${error.raw}\n`;
    }
    case "CUSTOM_ERROR": {
      return `\n\n${chalkError("X Error:")} ${error.raw}\n`;
    }
    case "BUILT_IN_ERROR": {
      const stackTrace = error.stackTrace.replace(/^Error: /, chalkError("X Error: "));
      return `\n\n${stackTrace}${formatErrorCauses(error.causes, { stackTrace: true })}\n`;
    }
  }
}
