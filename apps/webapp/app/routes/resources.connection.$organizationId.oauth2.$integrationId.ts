import { conform } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { ActionArgs, json } from "@remix-run/server-runtime";
import { redirect, typedjson } from "remix-typedjson";
import z from "zod";
import { prisma } from "~/db.server";
import { integrationAuthRepository } from "~/services/externalApis/integrationAuthRepository.server";
import { requireUserId } from "~/services/session.server";

export const schema = z
  .object({
    integrationIdentifier: z.string(),
    integrationAuthMethod: z.string(),
    title: z
      .string()
      .min(2, "The title must be unique and at least 2 characters long"),
    description: z.string().optional(),
    hasCustomClient: z.preprocess((value) => value === "on", z.boolean()),
    customClientId: z.string().optional(),
    customClientSecret: z.string().optional(),
    clientType: z.union([z.literal("DEVELOPER"), z.literal("EXTERNAL")]),
    redirectTo: z.string(),
    scopes: z.preprocess(
      (data) => (typeof data === "string" ? [data] : data),
      z
        .array(z.string(), {
          required_error: "You must select at least one scope",
        })
        .nonempty("You must select at least one scope")
    ),
  })
  .refine(
    (value) => {
      if (value.hasCustomClient) {
        return (
          value.customClientId !== undefined &&
          value.customClientId !== "" &&
          value.customClientSecret !== undefined &&
          value.customClientSecret !== ""
        );
      }
      return true;
    },
    {
      message:
        "You must enter a Client ID and Client secret if you want to use your own OAuth app.",
      path: ["customClientId"],
    }
  );

const ParamsSchema = z.object({
  organizationId: z.string(),
  integrationId: z.string(),
});

export async function action({ request, params }: ActionArgs) {
  const userId = await requireUserId(request);

  if (request.method.toUpperCase() !== "PUT") {
    return typedjson(
      {
        type: "error" as const,
        error: "Method not allowed",
      },
      { status: 405 }
    );
  }
  const { integrationId, organizationId } = ParamsSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  const {
    hasCustomClient,
    customClientId,
    customClientSecret,
    integrationIdentifier,
    integrationAuthMethod,
    clientType,
    title,
    description,
    redirectTo,
    scopes,
  } = submission.value;

  const organization = await prisma.organization.findFirstOrThrow({
    where: {
      id: organizationId,
      members: {
        some: {
          userId,
        },
      },
    },
  });

  const url = new URL(request.url);
  const redirectUrl =
    await integrationAuthRepository.populateMissingConnectionClientFields({
      id: integrationId,
      customClient: hasCustomClient
        ? { id: customClientId!, secret: customClientSecret! }
        : undefined,
      clientType,
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
