import childProcess from "child_process";
import util from "util";
import { z } from "zod";
import { telemetryClient } from "../telemetry/telemetry";
import { logger } from "../utilities/logger";
import { resolvePath } from "../utilities/parseNameAndPath";
import { RequireKeys } from "../utilities/requiredKeys";

const asyncExecFile = util.promisify(childProcess.execFile);

export const DevCommandOptionsSchema = z.object({
  port: z.coerce.number().optional(),
  hostname: z.string().optional(),
  envFile: z.string().optional(),
  clientId: z.string().optional(),
});

export type DevCommandOptions = z.infer<typeof DevCommandOptionsSchema>;
type ResolvedOptions = RequireKeys<DevCommandOptions, "envFile">;

const formattedDate = new Intl.DateTimeFormat("en", {
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

export async function devCommand(path: string, anyOptions: any) {
  telemetryClient.dev.started(path, anyOptions);

  const result = DevCommandOptionsSchema.safeParse(anyOptions);
  if (!result.success) {
    logger.error(result.error.message);

    return;
  }
  const options = result.data;

  const resolvedPath = resolvePath(path);
}
