import { intro, isCancel, outro, text } from "@clack/prompts";
import type { Command } from "commander";
import { z } from "zod";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  OutroCommandError,
  wrapCommandAction,
} from "../../cli/common.js";
import { printStandloneInitialBanner } from "../../utilities/initialBanner.js";
import { getPatApiClient } from "../projects/common.js";

const OrgsCreateCommandOptions = CommonCommandOptions.extend({
  name: z.string().trim().min(3).max(50).optional(),
});

type OrgsCreateCommandOptions = z.infer<typeof OrgsCreateCommandOptions>;

export function configureOrgsCreateCommand(program: Command) {
  return commonOptions(
    program
      .command("create")
      .description("Create a new Trigger.dev organization")
      .option("-n, --name <name>", "The name of the new organization")
      .action(async (options) => {
        await handleTelemetry(async () => {
          await printStandloneInitialBanner(true, options.profile);
          await orgsCreateCommand(options);
        });
      })
  );
}

async function orgsCreateCommand(options: unknown) {
  return await wrapCommandAction(
    "orgsCreateCommand",
    OrgsCreateCommandOptions,
    options,
    async (opts) => await createOrg(opts)
  );
}

async function createOrg(options: OrgsCreateCommandOptions) {
  intro("Creating a new organization");

  const apiClient = await getPatApiClient(options);
  const name = options.name ?? (await promptForName());
  const response = await apiClient.createOrg({ title: name });

  if (!response.success) {
    if (response.statusCode === 404) {
      throw new Error("Organization creation is disabled on this Trigger.dev instance.");
    }

    throw new Error(`Failed to create organization: ${response.error}`);
  }

  outro(`Created organization ${response.data.title} (${response.data.slug})`);
}

async function promptForName() {
  const name = await text({
    message: "What should the organization be called?",
    validate: (value) => {
      const length = value.trim().length;
      if (length < 3) return "Organization names must be at least 3 characters";
      if (length > 50) return "Organization names must be 50 characters or fewer";
      return undefined;
    },
  });

  if (isCancel(name)) {
    throw new OutroCommandError();
  }

  return name.trim();
}
