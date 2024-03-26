import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { env } from "~/env.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { r2 } from "~/v3/r2.server";

const ParamsSchema = z.object({
  "*": z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "PUT") {
    return { status: 405, body: "Method Not Allowed" };
  }

  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const parsedParams = ParamsSchema.parse(params);
  const filename = parsedParams["*"];

  if (!env.OBJECT_STORE_BASE_URL) {
    return json({ error: "Object store base URL is not set" }, { status: 500 });
  }

  if (!r2) {
    return json({ error: "Object store credentials are not set" }, { status: 500 });
  }

  const url = new URL(env.OBJECT_STORE_BASE_URL);
  url.pathname = `/payloads/${authenticationResult.environment.project.externalRef}/${authenticationResult.environment.slug}/${filename}`;
  url.searchParams.set("X-Amz-Expires", "300"); // 5 minutes

  const signed = await r2.sign(
    new Request(url, {
      method: "PUT",
    }),
    {
      aws: { signQuery: true },
    }
  );

  logger.debug("Generated presigned URL", {
    url: signed.url,
    headers: Object.fromEntries(signed.headers),
  });

  // Caller can now use this URL to upload to that object.
  return json({ presignedUrl: signed.url });
}

export async function loader({ request, params }: ActionFunctionArgs) {
  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const parsedParams = ParamsSchema.parse(params);
  const filename = parsedParams["*"];

  if (!env.OBJECT_STORE_BASE_URL) {
    return json({ error: "Object store base URL is not set" }, { status: 500 });
  }

  if (!r2) {
    return json({ error: "Object store credentials are not set" }, { status: 500 });
  }

  const url = new URL(env.OBJECT_STORE_BASE_URL);
  url.pathname = `/payloads/${authenticationResult.environment.project.externalRef}/${authenticationResult.environment.slug}/${filename}`;
  url.searchParams.set("X-Amz-Expires", "300"); // 5 minutes

  const signed = await r2.sign(
    new Request(url, {
      method: request.method,
    }),
    {
      aws: { signQuery: true },
    }
  );

  logger.debug("Generated presigned URL", {
    url: signed.url,
    headers: Object.fromEntries(signed.headers),
  });

  const getUrl = new URL(url.href);
  getUrl.searchParams.delete("X-Amz-Expires");

  // Caller can now use this URL to upload to that object.
  return json({ presignedUrl: signed.url });
}
