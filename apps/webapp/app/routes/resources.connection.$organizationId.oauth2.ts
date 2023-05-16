import type { ActionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson } from "remix-typedjson";
import z from "zod";
import { prisma } from "~/db.server";
import { apiAuthenticationRepository } from "~/services/externalApis/apiAuthenticationRepository.server";
import { requireUserId } from "~/services/session.server";

const FormSchema = z
  .object({
    integrationIdentifier: z.string(),
    integrationAuthMethod: z.string(),
    title: z.string().min(2),
    description: z.string().optional(),
    redirectTo: z.string(),
  })
  .passthrough();

const ParamsSchema = z.object({
  organizationId: z.string(),
});

export async function action({ request, params }: ActionArgs) {
  const userId = await requireUserId(request);

  if (request.method.toUpperCase() !== "POST") {
    return typedjson(
      {
        type: "error" as const,
        error: "Method not allowed",
      },
      { status: 405 }
    );
  }

  const parsedParams = ParamsSchema.parse(params);

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

  const organization = await prisma.organization.findFirstOrThrow({
    where: {
      id: parsedParams.organizationId,
      members: {
        some: {
          userId,
        },
      },
    },
  });

  const {
    integrationAuthMethod,
    integrationIdentifier,
    title,
    description,
    redirectTo,
  } = parsed.data;

  //check if there's an existing client with the same title
  const existingClient = await prisma.apiConnectionClient.findFirst({
    where: {
      organizationId: organization.id,
      title,
    },
  });

  if (existingClient) {
    return typedjson(
      {
        type: "error" as const,
        error: "A client with this title already exists",
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

  const url = new URL(request.url);

  const redirectUrl = await apiAuthenticationRepository.createConnectionClient({
    organizationId: organization.id,
    integrationIdentifier,
    integrationAuthMethod,
    scopes,
    title,
    description,
    redirectTo,
    url,
  });

  return redirect(redirectUrl);
}
