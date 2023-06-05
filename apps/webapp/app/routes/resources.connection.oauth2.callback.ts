import type { LoaderArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import z from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { apiAuthenticationRepository } from "~/services/externalApis/apiAuthenticationRepository.server";
import { OAuthClient, OAuthClientSchema } from "~/services/externalApis/types";
import { getSecretStore } from "~/services/secrets/secretStore.server";

const ParamsSchema = z
  .object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export async function loader({ request }: LoaderArgs) {
  if (request.method.toUpperCase() !== "GET") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const url = new URL(request.url);
  const parsedParams = ParamsSchema.safeParse(
    Object.fromEntries(url.searchParams)
  );

  if (!parsedParams.success) {
    // TODO: this should redirect to the integrations page (need to lookup orgid in cookie)
    throw new Response("Invalid params", { status: 400 });
  }

  if (parsedParams.data.error) {
    // TODO: this should redirect to the integrations page (need to lookup orgid in cookie)
    throw new Response(parsedParams.data.error, { status: 400 });
  }

  if (!parsedParams.data.code || !parsedParams.data.state) {
    throw new Response("Invalid params", { status: 400 });
  }

  const attempt = await prisma.apiConnectionAttempt.findUnique({
    where: {
      id: parsedParams.data.state,
    },
    include: {
      client: {
        include: {
          customClientReference: true,
        },
      },
    },
  });

  if (!attempt) {
    throw new Response("Invalid attempt", { status: 400 });
  }

  let customOAuthClient: OAuthClient | undefined;
  if (attempt.client.customClientReference) {
    const secretStore = getSecretStore(env.SECRET_STORE);
    customOAuthClient = await secretStore.getSecret(
      OAuthClientSchema,
      attempt.client.customClientReference.key
    );
  }

  try {
    await apiAuthenticationRepository.createConnectionFromAttempt({
      attempt,
      code: parsedParams.data.code,
      url,
      customOAuthClient,
    });

    return redirect(attempt.redirectTo);
  } catch (error) {
    console.error(error);

    // TODO: this should redirect to the integrations page (need to lookup orgid in attempt)
    throw new Response("Error", { status: 500 });
  }
}
