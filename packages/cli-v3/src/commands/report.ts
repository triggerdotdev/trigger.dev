import { tryCatch } from "@trigger.dev/core/utils";
import type { Command } from "commander";
import { z } from "zod";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  wrapCommandAction,
} from "../cli/common.js";
import { loadConfig } from "../config.js";
import { ReportPeriodSchema } from "../mcp/schemas.js";
import { getProjectClient } from "../utilities/session.js";
import { login } from "./login.js";

const ReportOptions = CommonCommandOptions.extend({
  config: z.string().optional(),
  projectRef: z.string().optional(),
  env: z.enum(["dev", "staging", "prod", "preview", "production"]).default("prod"),
  branch: z.string().optional(),
  period: ReportPeriodSchema.optional(),
});

type ReportOptions = z.infer<typeof ReportOptions>;

export function configureReportCommand(program: Command) {
  return commonOptions(
    program
      .command("report")
      .description(
        "Print an interpreted report for an environment. Currently: 'health' — is work flowing, is it your code, is the telemetry fresh."
      )
      .argument("[key]", "The report to render", "health")
      .option("-c, --config <config file>", "The name of the config file")
      .option(
        "-p, --project-ref <project ref>",
        "The project ref. Required if there is no config file"
      )
      .option("-e, --env <env>", "The environment (dev, staging, prod, preview)", "prod")
      .option("-b, --branch <branch>", "The preview branch when using --env preview")
      .option("--period <period>", "Time window, e.g. 1h (default), 24h, 7d")
  ).action(async (key, options) => {
    await handleTelemetry(async () => {
      await reportCommand(key, options);
    });
  });
}

async function reportCommand(key: string, options: unknown) {
  return await wrapCommandAction("report", ReportOptions, options, async (opts: ReportOptions) => {
    await _reportCommand(key, opts);
  });
}

async function _reportCommand(key: string, options: ReportOptions) {
  // Clean output: no banner, just the report (so it can be piped).
  const authorization = await login({
    embedded: true,
    defaultApiUrl: options.apiUrl,
    profile: options.profile,
    silent: true,
  });

  if (!authorization.ok) {
    throw new Error(`You must login first. Use the \`login\` CLI command.`);
  }

  const resolvedConfig = await loadConfig({
    overrides: { project: options.projectRef },
    configFile: options.config,
  });

  const env = options.env === "production" ? "prod" : options.env;
  if (env === "preview" && !options.branch) {
    throw new Error("Missing branch for the preview environment.");
  }

  const projectClient = await getProjectClient({
    accessToken: authorization.auth.accessToken,
    apiUrl: authorization.auth.apiUrl,
    projectRef: resolvedConfig.project,
    env,
    branch: options.branch,
    profile: options.profile,
  });

  if (!projectClient) {
    throw new Error("Failed to get project client");
  }

  // Colour in a real terminal; plain markdown when piped. NO_COLOR / FORCE_COLOR follow the
  // de-facto supports-color spec: NO_COLOR (any value) OR FORCE_COLOR=0 disables outright;
  // FORCE_COLOR set to anything else force-enables. Both win over isTTY (true even for
  // PTY-spawned agents — the mcp trap).
  const forceColor = process.env.FORCE_COLOR;
  const disabled = "NO_COLOR" in process.env || forceColor === "0";
  const useColor = disabled
    ? false
    : forceColor !== undefined
      ? true
      : Boolean(process.stdout.isTTY);
  const format = useColor ? "ansi" : "markdown";
  const [error, report] = await tryCatch(
    projectClient.client.getReport(key, { period: options.period, format })
  );

  if (error) {
    throw error;
  }

  process.stdout.write(report.endsWith("\n") ? report : `${report}\n`);
}
