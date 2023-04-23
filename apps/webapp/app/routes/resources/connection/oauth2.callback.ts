import { LoaderArgs, redirect } from "@remix-run/server-runtime";
import z from "zod";
import { prisma } from "~/db.server";
import { APIAuthenticationRepository } from "~/services/externalApis/apiAuthenticationRepository.server";

const ParamsSchema = z
  .object({
    code: z.string(),
    state: z.string(),
  })
  .passthrough();

export async function loader({ request }: LoaderArgs) {
  if (request.method.toUpperCase() !== "GET") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const url = new URL(request.url);
  const parsedParams = ParamsSchema.parse(Object.fromEntries(url.searchParams));

  const attempt = await prisma.aPIConnectionAttempt.findUnique({
    where: {
      id: parsedParams.state,
    },
  });

  if (!attempt) {
    throw new Response("Invalid attempt", { status: 400 });
  }

  try {
    const apiAuthRepo = new APIAuthenticationRepository(attempt.organizationId);
    apiAuthRepo.createConnection({
      apiIdentifier: attempt.apiIdentifier,
      authenticationMethodKey: attempt.authenticationMethodKey,
      scopes: attempt.scopes,
      code: parsedParams.code,
      title: attempt.title,
    });

    return redirect(attempt.redirectTo);
  } catch (error) {
    console.error(error);
    throw new Response("Error", { status: 500 });
  }
}
