import type { LogLevel } from "@trigger.dev/core";
import { Logger } from "@trigger.dev/core";
import { sensitiveDataReplacer } from "./sensitiveDataReplacer";

export const logger = new Logger(
  "webapp",
  (process.env.APP_LOG_LEVEL ?? "debug") as LogLevel,
  ["examples"],
  sensitiveDataReplacer
);
