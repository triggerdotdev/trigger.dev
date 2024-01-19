import { conform } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { redirect, typedjson } from "remix-typedjson";
import z from "zod";
import { prisma } from "~/db.server";
import { integrationAuthRepository } from "~/services/externalApis/integrationAuthRepository.server";
import { requireUserId } from "~/services/session.server";
import { requestUrl } from "~/utils/requestUrl.server";
import { featuresForRequest } from "~/features.server";

export function createSchema(
    constraints: {
        isManagedCloud: boolean
    }
) {
  return z
    .object({
      integrationIdentifier: z.string(),
      integrationAuthMethod: z.string(),
      title: z.string().min(2, "The title must be unique and at least 2 characters long"),
      description: z.string().optional(),
      hasCustomClient: z
        .preprocess((value) => value === "on", z.boolean())
        .superRefine((hasCustomClient, ctx) => {
          if (!hasCustomClient && !constraints.isManagedCloud) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Self-hosted trigger.dev installations must supply their own OAuth credentials.",
            })
          }
        }),
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
    )
}

const ParamsSchema = z.object({
  organizationId: z.string(),
  integrationId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
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

  const { isManagedCloud } = featuresForRequest(request);

  const { integrationId, organizationId } = ParamsSchema.parse(params);

  const formData = await request.formData();

  const formSchema = createSchema({
    isManagedCloud
  })

  const submission = parse(formData, { schema: formSchema });

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

  const url = requestUrl(request);

  const redirectUrl = await integrationAuthRepository.populateMissingConnectionClientFields({
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
