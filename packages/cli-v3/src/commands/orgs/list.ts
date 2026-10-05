import { intro, outro } from "@clack/prompts";
import type { Command } from "commander";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  wrapCommandAction,
} from "../../cli/common.js";
import { printStandloneInitialBanner } from "../../utilities/initialBanner.js";
import { logger } from "../../utilities/logger.js";
import { getPatApiClient } from "../projects/common.js";

export function configureOrgsListCommand(program: Command) {
  return commonOptions(
    program
      .command("list")
      .description("List the Trigger.dev organizations you belong to")
      .action(async (options) => {
        await handleTelemetry(async () => {
          await printStandloneInitialBanner(true, options.profile);
          await orgsListCommand(options);
        });
      })
  );
}

async function orgsListCommand(options: unknown) {
  return await wrapCommandAction(
    "orgsListCommand",
    CommonCommandOptions,
    options,
    async (opts) => await listOrgs(opts)
  );
}

async function listOrgs(options: CommonCommandOptions) {
  intro("Listing organizations");

  const apiClient = await getPatApiClient(options);
  const response = await apiClient.getOrgs();

  if (!response.success) {
    throw new Error(`Failed to list organizations: ${response.error}`);
  }

  if (response.data.length === 0) {
    outro("No organizations found. Create one with `trigger.dev orgs create`.");
    return;
  }

  logger.table(
    response.data.map((org) => ({
      name: org.title,
      slug: org.slug,
      id: org.id,
      created: org.createdAt.toLocaleString(),
    }))
  );
}
