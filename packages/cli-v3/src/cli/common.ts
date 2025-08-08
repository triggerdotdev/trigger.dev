import { outro } from "@clack/prompts";
import { Command } from "commander";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import { BundleError } from "../build/bundle.js";
import { CLOUD_API_URL } from "../consts.js";
import { chalkError } from "../utilities/cliOutput.js";
import { readAuthConfigCurrentProfileName } from "../utilities/configFiles.js";
import { logger } from "../utilities/logger.js";
import { trace } from "@opentelemetry/api";

export const CommonCommandOptions = z.object({
  apiUrl: z.string().optional(),
  logLevel: z.enum(["debug", "info", "log", "warn", "error", "none"]).default("log"),
  skipTelemetry: z.boolean().default(false),
  profile: z.string().default(readAuthConfigCurrentProfileName()),
});

export type CommonCommandOptions = z.infer<typeof CommonCommandOptions>;

export function commonOptions(command: Command) {
  return command
    .option("--profile <profile>", "The login profile to use", readAuthConfigCurrentProfileName())
    .option("-a, --api-url <value>", "Override the API URL", CLOUD_API_URL)
    .option(
      "-l, --log-level <level>",
      "The CLI log level to use (debug, info, log, warn, error, none). This does not effect the log level of your trigger.dev tasks.",
      "log"
    )
    .option("--skip-telemetry", "Opt-out of sending telemetry");
}

export class SkipLoggingError extends Error {}
export class SkipCommandError extends Error {}
export class OutroCommandError extends SkipCommandError {}

export async function handleTelemetry(action: () => Promise<void>) {
  try {
    await action();
  } catch (e) {
    process.exitCode = 1;
  }
}

export async function wrapCommandAction<T extends z.AnyZodObject, TResult>(
  name: string,
  schema: T,
  options: unknown,
  action: (opts: z.output<T>) => Promise<TResult>
): Promise<TResult | undefined> {
  try {
    const parsedOptions = schema.safeParse(options);

    if (!parsedOptions.success) {
      throw new Error(fromZodError(parsedOptions.error).toString());
    }

    logger.loggerLevel = parsedOptions.data.logLevel;

    logger.debug(`Running "${name}" with the following options`, {
      options: options,
    });

    const result = await action(parsedOptions.data);

    return result;
  } catch (e) {
    if (e instanceof SkipLoggingError) {
      // do nothing
    } else if (e instanceof OutroCommandError) {
      outro(e.message ?? "Operation cancelled");
    } else if (e instanceof SkipCommandError) {
      // do nothing
    } else if (e instanceof BundleError) {
      process.exit(1);
    } else {
      logger.log(`${chalkError("X Error:")} ${e instanceof Error ? e.message : String(e)}`);
    }

    throw e;
  }
}

export const tracer = trace.getTracer("trigger.dev/cli");

export function installExitHandler() {
  process.on("SIGINT", () => {
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    process.exit(0);
  });
}
