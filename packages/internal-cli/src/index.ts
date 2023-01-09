import { Command } from "commander";
import * as fs from "node:fs";
import { z } from "zod";
import invariant from "tiny-invariant";
import { getCatalog } from "internal-providers";
import { fromIni } from "@aws-sdk/credential-providers";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const program = new Command();

program
  .command("update")
  .description("Update the catalog")
  .argument(
    "<integration_file_path>",
    "The file path to the integration file. Probably ../../apps/webapp/integrations.yml"
  )
  .option("-e, --environment <environment>", "The environment to update")
  .option("-p, --pizzlyhost <pizzly_host>", "Pizzly host")
  .option("-s, --pizzlysecretkey <pizzly_secret_key>", "Pizzly secret key")
  .option("-a, --awsprofile <aws_profile>", "AWS profile name")
  .action(
    async (
      integration_file_path: string,
      options: {
        environment?: string;
        pizzlyhost?: string;
        pizzlysecretkey?: string;
        awsprofile?: string;
      }
    ) => {
      if (!integration_file_path) {
        console.error(
          "Missing integration file path.",
          "You probably want to pass in: ../../apps/webapp/integrations.yml"
        );
        return;
      }

      const environment = options.environment ?? "development";
      const pizzly_host = options.pizzlyhost ?? "http://localhost:3004";

      const file = fs.readFileSync(integration_file_path, "utf8");
      const catalog = getCatalog(file, true);

      const client = new SecretsManagerClient({
        region: "us-east-1",
        credentials: fromIni({ profile: options.awsprofile ?? "default" }),
      });

      const promises = catalog.map(async (integration) => {
        if (integration.authentication.type !== "oauth")
          return Promise.resolve();

        const environmentClientId =
          integration.authentication.environments[environment!].client_id;
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
          const { client_secret } = z
            .object({
              client_secret: z.string(),
            })
            .parse(secretObject);

          console.log(`Found secret for id: ${secretId}`);

          const hasExistingConfig = await hasConfig(
            pizzly_host,
            integration.slug,
            options.pizzlysecretkey
          );

          if (hasExistingConfig) {
            const response = await updateConfig(
              pizzly_host,
              integration.slug,
              environmentClientId,
              client_secret,
              integration.authentication.scopes,
              options.pizzlysecretkey
            );
            console.log(`Updated config for ${integration.slug}`);
          } else {
            const response = await createConfig(
              pizzly_host,
              integration.slug,
              environmentClientId,
              client_secret,
              integration.authentication.scopes,
              options.pizzlysecretkey
            );
            console.log(`Created config for ${integration.slug}`);
          }
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

async function hasConfig(pizzlyHost: string, slug: string, secretKey?: string) {
  const response = await fetch(`${pizzlyHost}/config/${slug}`, {
    headers: headers(secretKey),
  });
  const config = await response.json();

  if ("error" in config) {
    return false;
  }

  return true;
}

async function updateConfig(
  pizzlyHost: string,
  slug: string,
  client_id: string,
  client_secret: string,
  scopes: string[],
  secretKey?: string
) {
  const response = await fetch(`${pizzlyHost}/config`, {
    method: "PUT",
    headers: headers(secretKey),
    body: JSON.stringify({
      provider_config_key: slug,
      provider: slug,
      oauth_client_id: client_id,
      oauth_client_secret: client_secret,
      oauth_scopes: scopes.join(","),
    }),
  });
  return response.ok;
}

async function createConfig(
  pizzlyHost: string,
  slug: string,
  client_id: string,
  client_secret: string,
  scopes: string[],
  secretKey?: string
) {
  const response = await fetch(`${pizzlyHost}/config`, {
    method: "POST",
    headers: headers(secretKey),
    body: JSON.stringify({
      provider_config_key: slug,
      provider: slug,
      oauth_client_id: client_id,
      oauth_client_secret: client_secret,
      oauth_scopes: scopes.join(","),
    }),
  });
  return response.ok;
}

function headers(secretKey?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (secretKey) {
    headers.Authorization = `Basic ${Buffer.from(secretKey + ":").toString(
      "base64"
    )}`;
  }
  return headers;
}

program.parseAsync(process.argv);
