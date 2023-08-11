import { z } from "zod";
import { telemetryClient } from "../telemetry/telemetry.js";
import { logger } from "../utils/logger.js";
import { resolvePath } from "../utils/parseNameAndPath.js";
import { TriggerApi } from "../utils/triggerApi.js";
import { getEndpointIdFromPackageJson, getTriggerApiDetails } from "./dev.js";
import ora from "ora";

export const WhoAmICommandOptionsSchema = z.object({
  envFile: z.string(),
  clientId: z.string().optional(),
});

export type WhoAmICommandOptions = z.infer<typeof WhoAmICommandOptionsSchema>;

export async function whoamiCommand(path: string, anyOptions: any) {
  const loadingSpinner = ora(`Hold while we fetch your data`);
  loadingSpinner.start();

  telemetryClient.dev.started(path, anyOptions);

  const result = WhoAmICommandOptionsSchema.safeParse(anyOptions);
  if (!result.success) {
    logger.error(result.error.message);
    telemetryClient.dev.failed("invalid_options", anyOptions, result.error);
    return;
  }
  const options = result.data;

  const resolvedPath = resolvePath(path);

  // Read from package.json to get the endpointId
  const endpointId = await getEndpointIdFromPackageJson(resolvedPath, options);
  if (!endpointId) {
    logger.error(
      "You must run the `init` command first to setup the project – you are missing \n'trigger.dev': { 'endpointId': 'your-client-id' } from your package.json file, or pass in the --client-id option to this command"
    );
    telemetryClient.dev.failed("missing_endpoint_id", options);
    return;
  }
  // Read from .env.local or .env to get the TRIGGER_API_KEY and TRIGGER_API_URL
  const apiDetails = await getTriggerApiDetails(resolvedPath, options.envFile);

  if (!apiDetails) {
    telemetryClient.dev.failed("missing_api_key", options);
    return;
  }

  const triggerAPI = new TriggerApi(apiDetails.apiKey, apiDetails.apiUrl);
  const userData = await triggerAPI.whoami(apiDetails.apiKey);

  loadingSpinner.stop();

  logger.info(`
  environment: ${userData?.type}
  Trigger Client Id: ${endpointId} 
  User ID: ${userData?.userId}
  Project: 
   id:   ${userData?.project.id}
   slug: ${userData?.project.slug}
   name: ${userData?.project.name}
  Organization:
   id:    ${userData?.organization.id}
   slug:  ${userData?.organization.slug}
   title: ${userData?.organization.title}
  `);
  process.exit(1);
}
