import { randomUUID } from "crypto";
import ora from "ora";
import { z } from "zod";
import { getTriggerApiDetails } from "../utils/getTriggerApiDetails";
import { logger } from "../utils/logger";
import { resolvePath } from "../utils/parseNameAndPath";
import { TriggerApi } from "../utils/triggerApi";

const SendEventCommandOptionsSchema = z.object({
  envFile: z.string(),
  name: z.string(),
  payload: z.string(),
  id: z.string().optional(),
});

export type SendEventCommandOptions = z.infer<typeof SendEventCommandOptionsSchema>;

export async function sendEventCommand(path: string, anyOptions: any) {
  const result = SendEventCommandOptionsSchema.safeParse(anyOptions);

  if (!result.success) {
    logger.error(result.error.message);
    return;
  }

  console.log("Sending event", { options: result.data });

  const options = result.data;

  const resolvedPath = resolvePath(path);

  // Read from .env.local or .env to get the TRIGGER_API_KEY and TRIGGER_API_URL
  const apiDetails = await getTriggerApiDetails(resolvedPath, options.envFile);

  if (!apiDetails) {
    return;
  }

  const { apiUrl, apiKey } = apiDetails;

  const parsedPayload = safeJSONParse(options.payload);

  if (typeof parsedPayload !== "object") {
    logger.error(
      `The payload must be a valid JSON object. You can also pipe the payload in via stdin.`
    );
    return;
  }

  const id = options.id ?? randomUUID();
  const name = options.name;

  const spinner = ora(`[trigger.dev] Sending event ${name} with id ${id}`).start();

  const triggerApi = new TriggerApi(apiKey, apiUrl);

  const ok = await triggerApi.sendEvent(id, name, parsedPayload);

  if (ok) {
    spinner.succeed(`[trigger.dev] Event ${name} with id ${id} sent`);
  } else {
    spinner.fail(`[trigger.dev] Event ${name} with id ${id} failed to send`);
  }
}

function safeJSONParse(payload: string): any {
  try {
    return JSON.parse(payload);
  } catch (e) {
    return payload;
  }
}
