import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { KeyValueStoreRequestBodySchema } from "@trigger.dev/core";
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { KeyValueStore } from "~/services/store/keyValueStore.server";
import { assertExhaustive } from "~/utils";

const ParamsSchema = z.object({
  action: z.enum(["GET", "SET", "DELETE"]),
});

export async function action({ request, params }: ActionFunctionArgs) {
  logger.info("Key-value store action", { url: request.url });

  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    logger.info("Invalid params", { params });

    return json({ error: "Invalid params" }, { status: 400 });
  }

  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    logger.info("Invalid or missing api key", { url: request.url });
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const authenticatedEnv = authenticationResult.environment;

  // Now parse the request body
  const anyBody = await request.json();

  const bodyObject = z.object({}).passthrough().parse(anyBody);

  const body = KeyValueStoreRequestBodySchema.safeParse({
    ...bodyObject,
    action: parsedParams.data.action,
  });

  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const store = new KeyValueStore(authenticatedEnv);

  const { action } = body.data;

  try {
    switch (action) {
      case "GET": {
        const { key } = body.data;

        const value = await store.get(key);

        return json({ action, key, value });
      }
      case "SET": {
        const { key, value } = body.data;

        const setValue = await store.set(key, value);

        return json({ action, key, value: setValue });
      }
      case "DELETE": {
        const { key } = body.data;

        const deleted = await store.delete(key);

        return json({ action, key, deleted });
      }
      default: {
        assertExhaustive(action);
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error peforming key-value store action", {
        url: request.url,
        error: error.message,
      });

      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
