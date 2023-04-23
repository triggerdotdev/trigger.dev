import type { ActionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson } from "remix-typedjson";
import z from "zod";
import { prisma } from "~/db.server";
import { APIAuthenticationRepository } from "~/services/externalApis/apiAuthenticationRepository.server";

const FormSchema = z
  .object({
    organizationId: z.string(),
    api: z.string(),
    authenticationMethodKey: z.string(),
    title: z.string().min(2),
    redirectTo: z.string(),
  })
  .passthrough();

export async function action({ request }: ActionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return typedjson(
      {
        type: "error" as const,
        error: "Method not allowed",
      },
      { status: 405 }
    );
  }

  const formData = await request.formData();
  const formEntries = Object.fromEntries(formData.entries());
  const parsed = FormSchema.safeParse(formEntries);

  if (!parsed.success) {
    return typedjson(
      {
        type: "error" as const,
        error: "Invalid form data",
      },
      { status: 400 }
    );
  }

  const { organizationId, api, authenticationMethodKey, title, redirectTo } =
    parsed.data;

  //check if there's an existing connection with the same title
  const existingConnection = await prisma.aPIConnection.findFirst({
    where: {
      organizationId,
      title,
    },
  });

  if (existingConnection) {
    return typedjson(
      {
        type: "error" as const,
        error: "A connection with this title already exists",
      },
      { status: 400 }
    );
  }

  const scopes = Object.entries(formEntries)
    .filter(([key]) => key.startsWith("scopes["))
    .filter(([_, value]) => value === "on")
    .flatMap(([key]) => key.replace("scopes[", "").replace("]", ""));

  if (scopes.length === 0) {
    return typedjson(
      {
        type: "error" as const,
        error: "Please select at least one scope",
      },
      { status: 400 }
    );
  }

  const repository = new APIAuthenticationRepository(organizationId);
  const redirectUrl = await repository.createConnectionAttempt({
    apiIdentifier: api,
    authenticationMethodKey,
    scopes,
    title,
    redirectTo,
  });

  return redirect(redirectUrl);
}
