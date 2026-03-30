import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { generatePresignedUrl } from "~/v3/objectStore.server";

const ParamsSchema = z.object({
  "*": z.string(),
});

/**
 * PUT-only presign for packet uploads (SDK offload). Uses OBJECT_STORE_DEFAULT_PROTOCOL for
 * unprefixed keys; returns canonical storagePath for IOPacket.data. GET presigns use v1.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "PUT") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const parsedParams = ParamsSchema.parse(params);
  const filename = parsedParams["*"];

  const signed = await generatePresignedUrl(
    authenticationResult.environment.project.externalRef,
    authenticationResult.environment.slug,
    filename,
    "PUT"
  );

  if (!signed.success) {
    return json({ error: `Failed to generate presigned URL: ${signed.error}` }, { status: 500 });
  }

  if (signed.storagePath === undefined) {
    return json({ error: "Failed to resolve storage path for packet upload" }, { status: 500 });
  }

  return json({ presignedUrl: signed.url, storagePath: signed.storagePath });
}
