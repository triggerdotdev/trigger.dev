import { AwsClient } from "aws4fetch";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";

export const r2 = singleton("r2", initializeR2);

function initializeR2() {
  if (!env.OBJECT_STORE_ACCESS_KEY_ID || !env.OBJECT_STORE_SECRET_ACCESS_KEY) {
    return;
  }

  return new AwsClient({
    accessKeyId: env.OBJECT_STORE_ACCESS_KEY_ID,
    secretAccessKey: env.OBJECT_STORE_SECRET_ACCESS_KEY,
  });
}

export async function uploadToObjectStore(
  filename: string,
  data: string,
  contentType: string,
  environment: AuthenticatedEnvironment
): Promise<string> {
  if (!r2) {
    throw new Error("Object store credentials are not set");
  }

  if (!env.OBJECT_STORE_BASE_URL) {
    throw new Error("Object store base URL is not set");
  }

  const url = new URL(env.OBJECT_STORE_BASE_URL);
  url.pathname = `/packets/${environment.project.externalRef}/${environment.slug}/${filename}`;

  logger.debug("Uploading to object store", { url: url.href });

  const response = await r2.fetch(url.toString(), {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
    },
    body: data,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload output to ${url}: ${response.statusText}`);
  }

  return url.href;
}
