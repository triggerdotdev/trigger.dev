import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { z } from "zod";
import { generateJWT as internal_generateJWT } from "@trigger.dev/core/v3";

const RequestBodySchema = z.object({
  claims: z
    .object({
      scopes: z.array(z.string()).default([]),
    })
    .optional(),
  expirationTime: z.union([z.number(), z.string()]).optional(),
});

export async function action({ request }: LoaderFunctionArgs) {
  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const parsedBody = RequestBodySchema.safeParse(await request.json());

  if (!parsedBody.success) {
    return json(
      { error: "Invalid request body", issues: parsedBody.error.issues },
      { status: 400 }
    );
  }

  const claims = {
    sub: authenticationResult.environment.id,
    pub: true,
    ...parsedBody.data.claims,
  };

  const jwt = await internal_generateJWT({
    secretKey: authenticationResult.apiKey,
    payload: claims,
    expirationTime: parsedBody.data.expirationTime ?? "1h",
  });

  return json({ token: jwt });
}
