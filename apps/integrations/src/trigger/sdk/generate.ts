import { Command } from "commander";
import { catalog } from "integrations/catalog";
import { generateService } from "./generateService";

const program = new Command();

program
  .command("generate")
  .description("Generate API SDK(s)")
  .option(
    "-in, --integrations <integrations>",
    "Comma-separated list of integrations"
  )
  .action(async (options: { integrations?: string }) => {
    let integrationNames: string[] = [];
    if (options.integrations) {
      integrationNames = options.integrations.split(",").map((i) => i.trim());
    } else {
      integrationNames = Object.values(catalog.services).map((s) => s.service);
    }

    console.log(`Generating SDKs... ${integrationNames.join(", ")}`);

    for (let index = 0; index < integrationNames.length; index++) {
      const integrationName = integrationNames[index];
      const service = catalog.services[integrationName];
      if (!service) {
        throw new Error(`Could not find integration ${integrationName}`);
      }
      await generateService(service);
    }

    console.log(`Generated ${integrationNames.length} SDKs`);
  });

program.parseAsync(process.argv);
