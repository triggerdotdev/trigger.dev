import { CliResults } from "../cli/index.js";
import { getVersion } from "./getVersion.js";
import { TelemetryEvent } from "./triggerApi.js";
import { randomUUID } from "crypto";

export function createTelemetryEvent(cli: CliResults): TelemetryEvent {
  return {
    id: `anon:${randomUUID()}`,
    event: "scaffolded template",
    properties: {
      projectName: cli.flags.projectName,
      templateName: cli.templateName,
      noInstall: cli.flags.noInstall,
      noGit: cli.flags.noGit,
      arch: process.arch,
      platform: process.platform,
      nodeVersion: process.version,
      packageVersion: getVersion(),
    },
  };
}
