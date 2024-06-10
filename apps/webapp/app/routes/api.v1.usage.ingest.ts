import { ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { validateJWTToken } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";

const JWTPayloadSchema = z.object({
  environment_id: z.string(),
  org_id: z.string(),
  project_id: z.string(),
  run_id: z.string(),
  machine_preset: z.string(),
});

export async function action({ request }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const jwt = request.headers.get("x-trigger-jwt");

  if (!jwt) {
    return { status: 401, body: "Unauthorized" };
  }

  logger.debug("Validating JWT", { jwt });

  const jwtPayload = await validateJWTToken(jwt, JWTPayloadSchema);

  logger.debug("Validated JWT", { jwtPayload });

  return new Response(null, {
    status: 200,
  });
}
