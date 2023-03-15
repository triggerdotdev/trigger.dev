import { Logger, LogLevel } from "internal-platform";

export const logger = new Logger(
  "webapp",
  (process.env.APP_LOG_LEVEL ?? "debug") as LogLevel
);

export const projectLogger = logger.filter(
  "latestCommit",
  "dockerfile",
  "dockerignore"
);
