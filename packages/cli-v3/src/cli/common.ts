import { flattenAttributes } from "@trigger.dev/core/v3";
import { recordSpanException } from "@trigger.dev/core/v3/workers";
import { Command } from "commander";
import { z } from "zod";
import { getTracer, provider } from "../telemetry/tracing.js";
import { fromZodError } from "zod-validation-error";
import { logger } from "../utilities/logger.js";
import { outro } from "@clack/prompts";
import { chalkError } from "../utilities/cliOutput.js";
import { CLOUD_API_URL } from "../consts.js";
import { readAuthConfigCurrentProfileName } from "../utilities/configFiles.js";

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

    await provider?.forceFlush();
  } catch (e) {
    await provider?.forceFlush();

    process.exitCode = 1;
  }
}

export const tracer = getTracer();

export async function wrapCommandAction<T extends z.AnyZodObject, TResult>(
  name: string,
  schema: T,
  options: unknown,
  action: (opts: z.output<T>) => Promise<TResult>
): Promise<TResult> {
  return await tracer.startActiveSpan(name, async (span) => {
    try {
      const parsedOptions = schema.safeParse(options);

      if (!parsedOptions.success) {
        throw new Error(fromZodError(parsedOptions.error).toString());
      }

      span.setAttributes({
        ...flattenAttributes(parsedOptions.data, "cli.options"),
      });

      logger.loggerLevel = parsedOptions.data.logLevel;

      logger.debug(`Running "${name}" with the following options`, {
        options: options,
        spanContext: span?.spanContext(),
      });

      const result = await action(parsedOptions.data);

      span.end();

      return result;
    } catch (e) {
      if (e instanceof SkipLoggingError) {
        recordSpanException(span, e);
      } else if (e instanceof OutroCommandError) {
        outro("Operation cancelled");
      } else if (e instanceof SkipCommandError) {
        // do nothing
      } else {
        recordSpanException(span, e);

        logger.log(`${chalkError("X Error:")} ${e instanceof Error ? e.message : String(e)}`);
      }

      span.end();

      throw e;
    }
  });
}

export function installExitHandler() {
  process.on("SIGINT", () => {
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    process.exit(0);
  });
}
