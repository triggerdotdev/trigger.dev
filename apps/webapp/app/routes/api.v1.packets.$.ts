import { json ,type  ActionFunctionArgs  } from "@remix-run/server-runtime";
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { generatePresignedUrl } from "~/v3/r2.server";

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

  const presignedUrl = await generatePresignedUrl(
    authenticationResult.environment.project.externalRef,
    authenticationResult.environment.slug,
    filename,
    "PUT"
  );

  if (!presignedUrl) {
    return json({ error: "Failed to generate presigned URL" }, { status: 500 });
  }

  // Caller can now use this URL to upload to that object.
  return json({ presignedUrl });
}

export async function loader({ request, params }: ActionFunctionArgs) {
  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const parsedParams = ParamsSchema.parse(params);
  const filename = parsedParams["*"];

  const presignedUrl = await generatePresignedUrl(
    authenticationResult.environment.project.externalRef,
    authenticationResult.environment.slug,
    filename,
    "GET"
  );

  if (!presignedUrl) {
    return json({ error: "Failed to generate presigned URL" }, { status: 500 });
  }

  // Caller can now use this URL to fetch that object.
  return json({ presignedUrl });
}
