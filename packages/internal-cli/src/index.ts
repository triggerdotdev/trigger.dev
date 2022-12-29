import { Command } from "commander";
import * as fs from "node:fs";
import { z } from "zod";
import invariant from "tiny-invariant";
import { getCatalog } from "internal-catalog";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({
  region: "us-east-1",
});

const program = new Command();

program
  .command("update")
  .description("Update the catalog")
  .argument(
    "<integration_file_path>",
    "The file path to the integration file. Probably ../../apps/webapp/integrations.yml"
  )
  .option("-e, --environment <environment>", "The environment to update")
  .action(
    async (
      integration_file_path: string,
      options: { environment?: string }
    ) => {
      if (!integration_file_path) {
        console.error(
          "Missing integration file path.",
          "You probably want to pass in: ../../apps/webapp/integrations.yml"
        );
        return;
      }

      const environment = options.environment ?? "development";

      const file = fs.readFileSync(integration_file_path, "utf8");
      const catalog = getCatalog(file);

      const promises = catalog.map(async (integration) => {
        const environmentClientId =
          integration.environments[environment!].oauth.client_id;
        const secretId = `integrations/${integration.slug}/${environmentClientId}`;
        try {
          console.log(`Finding secret for id: ${secretId}`);

          const response = await client.send(
            new GetSecretValueCommand({
              SecretId: secretId,
              VersionStage: "AWSCURRENT", // VersionStage defaults to AWSCURRENT if unspecified
            })
          );

          const secretData = response.SecretString;
          invariant(secretData, `Secret data is missing: ${secretId}`);
          const secretObject = JSON.parse(secretData);
          const parsed = z
            .object({
              client_secret: z.string(),
            })
            .parse(secretObject);

          console.log(`Found secret for id: ${secretId}`);
        } catch (error) {
          // For a list of exceptions thrown, see
          // https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html
          throw error;
        }
      });

      await Promise.all(promises);
      console.log(`Added ${promises.length} secrets`);
    }
  );

async function getConfig() {}

program.parseAsync(process.argv);
