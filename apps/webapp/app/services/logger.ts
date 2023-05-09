import type { LogLevel } from "@trigger.dev/internal";
import { Logger } from "@trigger.dev/internal";

export const logger = new Logger(
  "webapp",
  (process.env.APP_LOG_LEVEL ?? "debug") as LogLevel
);

export const projectLogger = logger.filter(
  "latestCommit",
  "dockerfile",
  "dockerignore"
);
