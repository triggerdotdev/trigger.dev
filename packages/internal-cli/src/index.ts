import { Command } from "commander";
import * as fs from "node:fs";
import { z } from "zod";
import invariant from "tiny-invariant";
import { getIntegrations } from "integration-catalog";
import { fromIni } from "@aws-sdk/credential-providers";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import fetch from "node-fetch";
import {
  InternalIntegration,
  ServiceMetadata,
} from "@trigger.dev/integration-sdk";

const providersSchema = z.record(
  z.string(),
  z.object({
    client_id: z.string(),
  })
);

const program = new Command();

program
  .command("update")
  .description("Update the catalog")
  .argument(
    "<integration_file_path>",
    "The file path to the integration file. Probably ../../apps/webapp/integrations.yml"
  )
  .option("-p, --pizzlyhost <pizzly_host>", "Pizzly host")
  .option("-s, --pizzlysecretkey <pizzly_secret_key>", "Pizzly secret key")
  .option("-a, --awsprofile <aws_profile>", "AWS profile name")
  .option("-i, --integrationorigin <integration_origin>", "Integration origin")
  .option(
    "-ia, --integrationapikey <integration_api_key>",
    "Integration API key"
  )
  .action(
    async (
      integration_file_path: string,
      options: {
        pizzlyhost?: string;
        pizzlysecretkey?: string;
        awsprofile?: string;
        integrationorigin?: string;
        integrationapikey?: string;
      }
    ) => {
      if (!integration_file_path) {
        console.error(
          "Missing integration file path.",
          `You need to pass in the path to a JSON file which has this format: 
          {
            "github": {
              "client_id": "<your_client_id>"
            }
          }
          `
        );
        return;
      }

      const file = fs.readFileSync(integration_file_path, "utf8");
      const json = JSON.parse(file);
      const result = providersSchema.safeParse(json);

      if (!result.success) {
        console.error(
          `Integration file ${integration_file_path} is in the wrong file format`,
          result.error.format()
        );
        return;
      }
      const authProviders = result.data;
      const pizzly_host = options.pizzlyhost ?? "http://localhost:3004";

      //todo get all integrations, including from the new service
      if (!options.integrationorigin) {
        options.integrationorigin = "https://localhost:3006";
      }
      if (!options.integrationapikey) {
        console.error("Missing integration API key");
        return;
      }
      const providers = await getServiceMetadatas({
        integrationsOrigin: options.integrationorigin,
        integrationsApiKey: options.integrationapikey,
      });

      console.log(`Using pizzly host: ${pizzly_host}`);

      const client = new SecretsManagerClient({
        region: "us-east-1",
        credentials: fromIni({ profile: options.awsprofile ?? "default" }),
      });

      const promises = Object.entries(authProviders).map(
        async ([service, authentication]) => {
          const environmentClientId = authentication.client_id;

          if (!environmentClientId) {
            console.log(`No client id for ${service}`);
            console.log("Skipping…");
            return Promise.resolve();
          }

          const provider = providers[service];
          if (!provider) {
            console.log(`No provider found for ${service}`);
            console.log("Skipping…");
            return Promise.resolve();
          }

          //1st authentication obj
          const providerAuthentication = Object.values(
            provider.authentication
          )[0];
          if (
            providerAuthentication === undefined ||
            providerAuthentication.type !== "oauth2"
          ) {
            console.log(
              `The provider ${service} is the wrong type ${providerAuthentication.type}. Must be oauth2`
            );
            console.log("Skipping…");
            return Promise.resolve();
          }

          const secretId = `integrations/${service}/${environmentClientId}`;
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
              service,
              options.pizzlysecretkey
            );

            const scopes = Object.keys(providerAuthentication.scopes);

            if (hasExistingConfig) {
              const response = await updateConfig(
                pizzly_host,
                service,
                environmentClientId,
                client_secret,
                scopes,
                options.pizzlysecretkey
              );
              console.log(`Updated config for ${service} with scopes`, scopes);
            } else {
              const response = await createConfig(
                pizzly_host,
                service,
                environmentClientId,
                client_secret,
                scopes,
                options.pizzlysecretkey
              );
              console.log(`Created config for ${service} with scopes`, scopes);
            }
          } catch (error) {
            // For a list of exceptions thrown, see
            // https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html
            throw error;
          }
        }
      );

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

export async function getServiceMetadatas({
  integrationsOrigin,
  integrationsApiKey,
}: {
  integrationsOrigin: string;
  integrationsApiKey: string;
}): Promise<Record<string, ServiceMetadata>> {
  let services: Record<string, ServiceMetadata> = {};
  //get the old integrations, and turn them into an object
  const v1IntegrationsMetadata = getIntegrations(true).map((i) => i.metadata);
  const v1IntegrationsMetadataObject = v1IntegrationsMetadata.reduce(
    (acc, curr) => {
      acc[curr.service] = curr;
      return acc;
    },
    {} as Record<string, InternalIntegration["metadata"]>
  );

  try {
    const url = `${integrationsOrigin}/api/v2/services`;
    console.log("url", url);
    //get the new integrations, and turn them into an object
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${integrationsApiKey}`,
      },
    });

    console.log("response", response.status);

    const v2IntegrationsMetadata = (await response.json()) as {
      services: Record<string, ServiceMetadata>;
    };

    services = {
      ...v1IntegrationsMetadataObject,
      ...v2IntegrationsMetadata.services,
    };

    return services;
  } catch (err) {
    console.log("Error getting services", err);
    return services;
  }
}

program.parseAsync(process.argv);
