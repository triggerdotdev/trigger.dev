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

  const method = request.method.toUpperCase();

  if (method !== "DELETE" && method !== "PUT") {
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

  const { key } = parsedParams.data;

  try {
    switch (method) {
      case "DELETE": {
        const deleted = await store.delete(key);

        return json({ action: "DELETE", key, deleted });
      }
      case "PUT": {
        const requestBodyBytes = await getRequestBodyByteLength(request);

        if (requestBodyBytes > MAX_BODY_BYTE_LENGTH) {
          logger.info("Max request body size exceeded", { requestBodyBytes });

          return json(
            { error: `Max request body size exceeded: ${MAX_BODY_BYTE_LENGTH}` },
            { status: 413 }
          );
        }

        const value = await request.json();

        const setValue = await store.set(key, value);

        return json({ action: "SET", key, value: setValue });
      }
      default: {
        return json({ error: "Method Not Allowed" }, { status: 405 });
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

export async function loader({ request, params }: LoaderFunctionArgs) {
  logger.info("Key-value store loader", { url: request.url });

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

  const { key } = parsedParams.data;

  try {
    const value = await store.get(key);

    return json({ action: "GET", key, value });
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error during key-value store get", {
        url: request.url,
        error: error.message,
      });

      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}

const getRequestBodyByteLength = async (request: Request) => {
  const clonedRequest = request.clone();
  const buffer = await clonedRequest.arrayBuffer();
  return buffer.byteLength;
};
