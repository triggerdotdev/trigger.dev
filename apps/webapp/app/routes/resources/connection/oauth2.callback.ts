import type { LoaderArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import z from "zod";
import { prisma } from "~/db.server";
import { apiConnectionRepository } from "~/services/externalApis/apiAuthenticationRepository.server";

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
  });

  if (!attempt) {
    throw new Response("Invalid attempt", { status: 400 });
  }

  try {
    await apiConnectionRepository.createConnection({
      organizationId: attempt.organizationId,
      apiIdentifier: attempt.apiIdentifier,
      authenticationMethodKey: attempt.authenticationMethodKey,
      scopes: attempt.scopes,
      code: parsedParams.data.code,
      title: attempt.title,
      pkceCode: attempt.securityCode ?? undefined,
    });

    return redirect(attempt.redirectTo);
  } catch (error) {
    console.error(error);

    // TODO: this should redirect to the integrations page (need to lookup orgid in attempt)
    throw new Response("Error", { status: 500 });
  }
}
