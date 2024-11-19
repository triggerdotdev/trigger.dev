import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { KeyValueStore } from "~/services/store/keyValueStore.server";

const ParamsSchema = z.object({
  key: z.string(),
});

const MAX_BODY_BYTE_LENGTH = 256 * 1024;

export async function action({ request, params }: ActionFunctionArgs) {
  logger.info("Key-value store action", { url: request.url });

  const ActionMethodSchema = z.enum(["DELETE", "PUT"]);

  const parsedMethod = ActionMethodSchema.safeParse(request.method.toUpperCase());

  if (!parsedMethod.success) {
    return json({ error: "Method Not Allowed" }, { status: 405 });
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    logger.info("Invalid params", { params });

    return json({ error: "Invalid params" }, { status: 400 });
  }

  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    logger.info("Invalid or missing api key", { url: request.url });
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const authenticatedEnv = authenticationResult.environment;

  const store = new KeyValueStore(authenticatedEnv);

  const decodedKey = decodeURIComponent(parsedParams.data.key);

  try {
    switch (parsedMethod.data) {
      case "DELETE": {
        const deleted = await store.delete(decodedKey);

        return json({ action: "DELETE", key: decodedKey, deleted });
      }
      case "PUT": {
        const value = await request.text();

        const serializedValueBytes = value.length;

        if (serializedValueBytes > MAX_BODY_BYTE_LENGTH) {
          logger.info("Max request body size exceeded", { serializedValueBytes });

          return json(
            { error: `Max request body size exceeded: ${MAX_BODY_BYTE_LENGTH} bytes` },
            { status: 413 }
          );
        }

        const setValue = await store.set(decodedKey, value);

        return json({ action: "SET", key: decodedKey, value: setValue });
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error peforming key-value store action", {
        method: parsedMethod.data,
        url: request.url,
        error: error.message,
      });

      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  logger.info("Key-value store loader", { url: request.url });

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    logger.info("Invalid params", { params });

    return json({ error: "Invalid params" }, { status: 400 });
  }

  const ActionMethodSchema = z.enum(["GET", "HEAD"]);

  const parsedMethod = ActionMethodSchema.safeParse(request.method.toUpperCase());

  if (!parsedMethod.success) {
    return json({ error: "Method Not Allowed" }, { status: 405 });
  }

  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    logger.info("Invalid or missing api key", { url: request.url });
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const authenticatedEnv = authenticationResult.environment;

  const store = new KeyValueStore(authenticatedEnv);

  const { key } = parsedParams.data;

  try {
    switch (parsedMethod.data) {
      case "GET": {
        const value = await store.get(key);

        return json({ action: "GET", key, value });
      }
      case "HEAD": {
        const has = await store.has(key);

        if (!has) {
          return new Response("Key not found", { status: 404 });
        }

        return new Response("Key found", { status: 200 });
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error peforming key-value store action", {
        method: parsedMethod.data,
        url: request.url,
        error: error.message,
      });

      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
