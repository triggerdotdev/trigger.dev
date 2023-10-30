import { conform } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { redirect, typedjson } from "remix-typedjson";
import z from "zod";
import { prisma } from "~/db.server";
import { integrationAuthRepository } from "~/services/externalApis/integrationAuthRepository.server";
import { requireUserId } from "~/services/session.server";
import { requestUrl } from "~/utils/requestUrl.server";

export function createSchema(
  constraints: {
    isTitleUnique?: (title: string) => Promise<boolean>;
    isSlugUnique?: (slug: string) => Promise<boolean>;
  } = {}
) {
  return z
    .object({
      id: z.string(),
      slug: z
        .string()
        .min(2, "The id must be at least 2 characters long")
        .superRefine((title, ctx) => {
          if (constraints.isSlugUnique === undefined) {
            //client-side validation skips this
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: conform.VALIDATION_UNDEFINED,
            });
          } else {
            // Tell zod this is an async validation by returning the promise
            return constraints.isSlugUnique(title).then((isUnique) => {
              if (isUnique) {
                return;
              }

              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "The id must be unique in your organization",
              });
            });
          }
        }),
      integrationIdentifier: z.string(),
      integrationAuthMethod: z.string(),
      title: z
        .string()
        .min(2, "The title must be unique and at least 2 characters long")
        .superRefine((title, ctx) => {
          if (constraints.isTitleUnique === undefined) {
            //client-side validation skips this
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: conform.VALIDATION_UNDEFINED,
            });
          } else {
            // Tell zod this is an async validation by returning the promise
            return constraints.isTitleUnique(title).then((isUnique) => {
              if (isUnique) {
                return;
              }

              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "The title must be unique in your organization",
              });
            });
          }
        }),
      description: z.string().optional(),
      hasCustomClient: z.preprocess((value) => value === "on", z.boolean()),
      customClientId: z.string().optional(),
      customClientSecret: z.string().optional(),
      clientType: z.union([z.literal("DEVELOPER"), z.literal("EXTERNAL")]),
      redirectTo: z.string(),
      scopes: z.preprocess(
        (data) => (typeof data === "string" ? [data] : data),
        z.array(z.string()).default([])
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
}

const ParamsSchema = z.object({
  organizationId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
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
  const { organizationId } = ParamsSchema.parse(params);

  const formData = await request.formData();

  const formSchema = createSchema({
    isTitleUnique: async (title) => {
      const existingIntegration = await prisma.integration.findFirst({
        where: {
          organizationId,
          title,
        },
      });

      return !existingIntegration;
    },
    isSlugUnique: async (slug) => {
      const existingIntegration = await prisma.integration.findFirst({
        where: {
          organizationId,
          slug,
        },
      });

      return !existingIntegration;
    },
  });

  const submission = await parse(formData, { schema: formSchema, async: true });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  const {
    id,
    slug,
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

  const redirectUrl = await integrationAuthRepository.createConnectionClient({
    id,
    slug,
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
