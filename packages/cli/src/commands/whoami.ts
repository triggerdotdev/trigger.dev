import { z } from "zod";
import { logger } from "../utils/logger";
import { resolvePath } from "../utils/parseNameAndPath";
import { TriggerApi } from "../utils/triggerApi";
import { DevCommandOptions, getEndpointId } from "./dev";
import ora from "ora";
import { getTriggerApiDetails } from "../utils/getTriggerApiDetails";
import { getJsRuntime } from "../utils/jsRuntime";

export const WhoAmICommandOptionsSchema = z.object({
  envFile: z.string(),
});

export type WhoAmICommandOptions = z.infer<typeof WhoAmICommandOptionsSchema>;

export async function whoamiCommand(path: string, anyOptions: any) {
  const loadingSpinner = ora(`Hold while we fetch your data`);
  loadingSpinner.start();

  const result = WhoAmICommandOptionsSchema.safeParse(anyOptions);
  if (!result.success) {
    logger.error(result.error.message);
    return;
  }
  const options = result.data;

  const resolvedPath = resolvePath(path);

  // Read from package.json to get the endpointId
  const runtime = await getJsRuntime(resolvedPath, logger);
  const endpointId = await getEndpointId(runtime);
  if (!endpointId) {
    logger.error(
      "You must run the `init` command first to setup the project – you are missing \n'trigger.dev': { 'endpointId': 'your-client-id' } from your package.json file, or pass in the --client-id option to this command"
    );
    loadingSpinner.stop();
    return;
  }
  // Read from .env.local or .env to get the TRIGGER_API_KEY and TRIGGER_API_URL
  const apiDetails = await getTriggerApiDetails(resolvedPath, options.envFile);

  if (!apiDetails) {
    return;
  }

  const triggerAPI = new TriggerApi(apiDetails.apiKey, apiDetails.apiUrl);
  const userData = await triggerAPI.whoami();

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
