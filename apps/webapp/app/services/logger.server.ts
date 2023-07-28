import type { LogLevel } from "../../../../packages/core/src";
import { Logger } from "../../../../packages/core/src";
import { sensitiveDataReplacer } from "./sensitiveDataReplacer";

export const logger = new Logger(
  "webapp",
  (process.env.APP_LOG_LEVEL ?? "debug") as LogLevel,
  ["examples"],
  sensitiveDataReplacer
);
