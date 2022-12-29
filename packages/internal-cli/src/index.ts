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

async function run() {
  const args = process.argv.slice(2);
  const [integrationFilePath] = args;

  if (!integrationFilePath) {
    console.error(
      "Missing integration file path.",
      "You probably want to pass in: ../../apps/webapp/integrations.yml"
    );
    return;
  }

  let environment = args[1];
  if (!environment) {
    environment = "development";
  }

  console.log(`Environment: ${environment}`);

  const file = fs.readFileSync(integrationFilePath, "utf8");
  const catalog = getCatalog(file);

  const promises = catalog.map(async (integration) => {
    const environmentClientId =
      integration.environments[environment].oauth.client_id;
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
    } catch (error) {
      // For a list of exceptions thrown, see
      // https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html
      throw error;
    }
  });

  await Promise.all(promises);
  console.log(`Added ${promises.length} secrets`);
}

run();
