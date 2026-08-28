import { log } from "@clack/prompts";
import { stripVTControlCharacters } from "node:util";
import {
  DeploymentEventFromString,
  type DeploymentFinalizedEvent,
} from "@trigger.dev/core/v3/schemas";
import chalk from "chalk";
import { z } from "zod";
import { chalkError, chalkGrey, chalkWarning } from "../utilities/cliOutput.js";
import { logger } from "../utilities/logger.js";
import { spinner } from "../utilities/windows.js";

export const BuildLogsMode = z.enum(["compact", "full"]);
export type BuildLogsMode = z.infer<typeof BuildLogsMode>;

export function resolveBuildLogsMode(
  requested: BuildLogsMode,
  env: { plain: boolean; ci: boolean; tty: boolean; windows: boolean }
): BuildLogsMode {
  // No redrawable spinner in CI, piped output, or the Windows fallback spinner.
  if (env.plain || env.ci || !env.tty || env.windows) {
    return "full";
  }
  return requested;
}

type BuildLogLevel = "debug" | "info" | "warn" | "error";

export type BuildLogEntry = {
  timestamp: Date;
  level: BuildLogLevel;
  message: string;
};

type BuildLogOutcome = "success" | "failure" | "abandoned";

export type BuildLogRenderer = {
  readonly started: boolean;
  log(entry: BuildLogEntry): void;
  finish(message: string, outcome: BuildLogOutcome): void;
};

type SpinnerLike = {
  start(msg?: string): void;
  message(msg?: string): void;
  stop(msg?: string, code?: number): void;
};

export type BuildLogRendererOptions = {
  mode: BuildLogsMode;
  title: string;
  tailSize?: number;
  columns?: number;
  spinner?: SpinnerLike;
  print?: (line: string) => void;
  success?: (message: string) => void;
};

function formatBuildLogLine(entry: BuildLogEntry): string {
  const timestamp = chalkGrey(
    entry.timestamp.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
    })
  );

  const message =
    entry.level === "error"
      ? chalk.bold(chalkError(entry.message))
      : entry.level === "warn"
        ? chalkWarning(entry.message)
        : entry.level === "debug"
          ? chalkGrey(entry.message)
          : entry.message;

  return `│  ${timestamp}  ${message}`;
}

export function createBuildLogRenderer(options: BuildLogRendererOptions): BuildLogRenderer {
  const $spinner = options.spinner ?? spinner();
  const print = options.print ?? ((line: string) => console.log(line));
  const success = options.success ?? ((message: string) => log.success(message));
  const tailSize = options.tailSize ?? 20;
  const tail: string[] = [];
  const notices: string[] = [];
  let started = false;

  $spinner.start("Build queued");

  const compactMessage = (message: string) => {
    const columns = options.columns ?? process.stdout.columns ?? 120;
    const available = Math.max(columns - options.title.length - 8, 20);
    const singleLine = stripVTControlCharacters(message).replace(/\s+/g, " ").trim();
    return singleLine.length > available ? `${singleLine.slice(0, available - 1)}…` : singleLine;
  };

  return {
    get started() {
      return started;
    },
    log(entry) {
      const line = formatBuildLogLine(entry);

      if (options.mode === "full") {
        if (!started) {
          $spinner.stop("Build started");
          print("│");
        }
        started = true;
        print(line);
        return;
      }

      started = true;
      tail.push(line);
      if (tail.length > tailSize) {
        tail.shift();
      }
      if ((entry.level === "warn" || entry.level === "error") && notices.length < tailSize) {
        notices.push(line);
      }
      const message = compactMessage(entry.message);
      if (message.length > 0 && !/^[-=#*_.\s]+$/.test(message)) {
        $spinner.message(`${options.title}: ${message}`);
      }
    },
    finish(message, outcome) {
      if (options.mode === "full" && started) {
        if (outcome === "success") {
          success(message);
        }
        return;
      }

      $spinner.stop(message, outcome === "failure" ? 2 : undefined);

      if (options.mode !== "compact") {
        return;
      }

      const lines = outcome === "failure" ? tail : outcome === "success" ? notices : [];
      if (lines.length === 0) {
        return;
      }

      print("│");
      print(
        `│  ${chalkGrey(
          outcome === "failure"
            ? `Last ${lines.length} lines of the build log:`
            : `Build warnings (${lines.length}):`
        )}`
      );
      for (const line of lines) {
        print(line);
      }
      print("│");
    },
  };
}

export type DeploymentEventRecord = {
  seqNum: number;
  timestamp: number | string | Date;
  body: string;
};

export async function streamDeploymentEvents(
  records: AsyncIterable<DeploymentEventRecord>,
  renderer: BuildLogRenderer,
  onFinalized: () => void
): Promise<DeploymentFinalizedEvent["data"] | undefined> {
  let finalEvent: DeploymentFinalizedEvent["data"] | undefined;

  for await (const record of records) {
    const result = DeploymentEventFromString.safeParse(record.body);
    if (!result.success) {
      logger.debug("Failed to parse deployment event, skipping", {
        error: result.error,
        record: record.body,
      });
      continue;
    }

    const event = result.data;

    switch (event.type) {
      case "log": {
        renderer.log({
          timestamp: new Date(record.timestamp),
          level: event.data.level,
          message: event.data.message,
        });
        break;
      }
      case "finalized": {
        finalEvent = event.data;
        onFinalized();
        break;
      }
      default: {
        event satisfies never;
        logger.debug("Unknown deployment event, skipping", { event });
      }
    }
  }

  return finalEvent;
}
