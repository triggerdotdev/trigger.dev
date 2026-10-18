import { intro, log, outro } from "@clack/prompts";
import type { ApiClient, RetrieveRunResponse } from "@trigger.dev/core/v3";
import { MachinePresetName } from "@trigger.dev/core/v3";
import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { CliApiClient } from "../../apiClient.js";
import { commonOptions, handleTelemetry, wrapCommandAction } from "../../cli/common.js";
import { printInitialBanner } from "../../utilities/initialBanner.js";
import { logger } from "../../utilities/logger.js";
import { formatEnvInfo, resolveRunsClient, RunsCommonOptions } from "../runs/common.js";

const POLL_INTERVAL_MS = 1_000;

const TasksTriggerCommandOptions = RunsCommonOptions.extend({
  taskId: z.string(),
  // Unlike the runs commands, default to dev so testing a task never triggers it in production
  env: z.enum(["dev", "prod", "staging", "preview", "production"]).default("dev"),
  payload: z.string().optional(),
  payloadFile: z.string().optional(),
  tag: z.array(z.string()).optional(),
  idempotencyKey: z.string().optional(),
  delay: z.string().optional(),
  ttl: z.string().optional(),
  queue: z.string().optional(),
  machine: MachinePresetName.optional(),
  wait: z.boolean().default(false),
  timeout: z.coerce.number().int().positive().optional(),
});

type TasksTriggerCommandOptions = z.infer<typeof TasksTriggerCommandOptions>;

export function configureTasksTriggerCommand(program: Command) {
  return commonOptions(
    program
      .command("trigger")
      .description("Trigger a task, in the dev environment unless you pass --env")
      .argument("<task id>", "The id of the task to trigger")
      .option(
        "--payload <json>",
        'The payload as JSON, e.g. \'{"name":"Ada"}\'. Without it, the task gets no payload.'
      )
      .option("--payload-file <path>", "Read the payload from a JSON file")
      .option("--tag <tag>", "A tag to add to the run. Repeat it to add more than one.", collect)
      .option("--idempotency-key <key>", "Return the existing run if one has this key")
      .option("--delay <delay>", "Wait before running, e.g. 30s, 5m or an ISO date")
      .option("--ttl <ttl>", "Expire the run if it hasn't started within this time, e.g. 10m")
      .option("--queue <queue>", "The queue to run in, instead of the task's queue")
      .option(
        "--machine <machine>",
        `The machine to run on (${MachinePresetName.options.join(", ")})`
      )
      .option(
        "--wait",
        "Wait for the run to finish, print its output or error, and exit 1 if it failed"
      )
      .option("--timeout <seconds>", "With --wait, stop waiting after this many seconds")
      .option("-c, --config <config file>", "The name of the config file")
      .option(
        "-p, --project-ref <project ref>",
        "The project ref. Required if there is no config file"
      )
      .option("-e, --env <env>", "The environment to use (dev, prod, staging, preview)", "dev")
      .option("-b, --branch <branch>", "The preview or dev branch when using --env preview or dev")
  ).action(async (taskId, options) => {
    await handleTelemetry(async () => {
      await printInitialBanner(false, options.profile);
      await tasksTriggerCommand({ ...options, taskId });
    });
  });
}

function collect(value: string, previous: string[] | undefined) {
  return [...(previous ?? []), value];
}

async function tasksTriggerCommand(options: unknown) {
  return await wrapCommandAction(
    "tasksTriggerCommand",
    TasksTriggerCommandOptions,
    options,
    async (opts) => await triggerTask(opts)
  );
}

async function triggerTask(options: TasksTriggerCommandOptions) {
  intro(`Triggering ${options.taskId}`);

  const payload = await readPayload(options);
  const { apiClient, projectRef, env, branch, login } = await resolveRunsClient(options);
  const cliClient = new CliApiClient(login.auth.apiUrl, login.auth.accessToken, branch);

  // An unknown task id still creates a run, which waits for a version with that task until it
  // expires. Fail fast instead. If there's no current version yet, there's nothing to check.
  const currentWorker = await cliClient.getWorkerByTag(projectRef, env, "current");

  if (currentWorker.success) {
    const { worker } = currentWorker.data;

    if (!worker.tasks.some((task) => task.slug === options.taskId)) {
      throw new Error(
        `There's no task with the id "${options.taskId}" in the current version (${
          worker.version
        }). Its tasks are: ${worker.tasks.map((task) => task.slug).join(", ") || "none"}.${
          env === "dev"
            ? " If you just added the task, wait for the dev command to print that the local worker is ready."
            : ""
        }`
      );
    }
  } else {
    logger.debug("Couldn't get the current worker to check the task id", {
      error: currentWorker.error,
    });
  }

  const result = await apiClient.triggerTask(options.taskId, {
    payload,
    options: {
      tags: options.tag,
      idempotencyKey: options.idempotencyKey,
      delay: options.delay,
      ttl: options.ttl,
      queue: options.queue ? { name: options.queue } : undefined,
      machine: options.machine,
    },
  });

  const runUrl = `${login.dashboardUrl}/projects/v3/${projectRef}/runs/${result.id}`;

  log.success(
    `${result.isCached ? "Found an existing run with this idempotency key" : "Triggered"}: ${
      result.id
    }\n${runUrl}`
  );

  if (env === "dev") {
    // Without a dev session, the run waits in the queue until one starts or the run expires
    const devStatus = await cliClient.getDevStatus(projectRef);

    if (devStatus.success && !devStatus.data.isConnected) {
      log.warn(
        `The dev command isn't running for this project, so the run will wait in the queue until you start it with \`trigger.dev dev${
          branch ? ` --branch ${branch}` : ""
        }\`.`
      );
    }
  }

  const envInfo = `Project: ${projectRef} | Environment: ${formatEnvInfo(env, branch)}`;

  if (!options.wait) {
    log.message(
      `Check on it with: trigger.dev runs get ${result.id} --env ${env}${
        branch ? ` --branch ${branch}` : ""
      }`
    );
    outro(envInfo);
    return;
  }

  const run = await waitForRun(apiClient, result.id, options.timeout);

  if (!run || !isFinished(run)) {
    log.warn(
      `Stopped waiting after ${options.timeout}s.${run ? ` The run is ${run.status}.` : ""}`
    );
    outro(envInfo);
    // A poll may still be in flight, and it shouldn't keep the process alive. Flush first, because
    // writes to a pipe are asynchronous on macOS and Windows, and exiting would cut them off.
    await flushOutput();
    process.exit(1);
  }

  const duration = run.durationMs > 0 ? ` in ${(run.durationMs / 1000).toFixed(2)}s` : "";

  if (run.isSuccess) {
    log.success(`${run.status}${duration}`);
    log.message(`Output:\n${formatOutput(run, runUrl)}`);
  } else {
    log.error(`${run.status}${duration}`);

    if (run.error) {
      log.message(
        run.error.stackTrace ?? `${run.error.name ? `${run.error.name}: ` : ""}${run.error.message}`
      );
    }

    process.exitCode = 1;
  }

  outro(envInfo);
}

export async function readPayload(
  options: Pick<TasksTriggerCommandOptions, "payload" | "payloadFile">
): Promise<unknown> {
  if (options.payload !== undefined && options.payloadFile !== undefined) {
    throw new Error("Pass either --payload or --payload-file, not both.");
  }

  const [json, source] =
    options.payloadFile !== undefined
      ? [await readFile(options.payloadFile, "utf8"), options.payloadFile]
      : [options.payload, "--payload"];

  if (json === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(json);
  } catch (error) {
    throw new Error(
      `${source} isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Returns the run once it finishes, or its last known state when the timeout passes first. */
async function waitForRun(
  apiClient: ApiClient,
  runId: string,
  timeoutInSeconds: number | undefined
): Promise<RetrieveRunResponse | undefined> {
  const deadline = timeoutInSeconds ? Date.now() + timeoutInSeconds * 1000 : undefined;
  let run: RetrieveRunResponse | undefined;

  while (true) {
    const latest = await beforeDeadline(apiClient.retrieveRun(runId), deadline);

    if (!latest) {
      return run;
    }

    // Log each status once, so it's clear when a run is stuck, e.g. QUEUED with no dev session
    if (!isFinished(latest) && latest.status !== run?.status) {
      log.step(`${latest.status}…`);
    }

    run = latest;

    if (isFinished(run)) {
      return run;
    }

    const delay = deadline ? Math.min(POLL_INTERVAL_MS, deadline - Date.now()) : POLL_INTERVAL_MS;

    if (delay <= 0) {
      return run;
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/** Resolves once everything written to stdout and stderr so far has been handed to the OS. */
function flushOutput() {
  return Promise.all(
    [process.stdout, process.stderr].map(
      (stream) => new Promise<void>((resolve) => stream.write("", () => resolve()))
    )
  );
}

/**
 * Resolves to undefined if the deadline passes first. Requests can't be aborted, and their
 * retries could otherwise keep waiting well past --timeout.
 */
export async function beforeDeadline<T>(
  promise: PromiseLike<T>,
  deadline: number | undefined
): Promise<T | undefined> {
  if (deadline === undefined) {
    return await promise;
  }

  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// The API's isCompleted leaves out runs that expired or hit their maxDuration
function isFinished(run: RetrieveRunResponse) {
  return run.isCompleted || run.status === "EXPIRED" || run.status === "TIMED_OUT";
}

function formatOutput(run: RetrieveRunResponse, runUrl: string) {
  if (run.outputPresignedUrl) {
    return `Too large to show here, view it in the dashboard: ${runUrl}`;
  }

  if (run.output === undefined) {
    return "(none)";
  }

  return typeof run.output === "string" ? run.output : JSON.stringify(run.output, null, 2);
}
