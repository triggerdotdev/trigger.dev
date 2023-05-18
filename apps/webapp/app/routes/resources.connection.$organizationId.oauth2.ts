import { ActionArgs, json } from "@remix-run/server-runtime";
import { redirect, typedjson } from "remix-typedjson";
import z from "zod";
import { prisma } from "~/db.server";
import { apiAuthenticationRepository } from "~/services/externalApis/apiAuthenticationRepository.server";
import { requireUserId } from "~/services/session.server";
import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";

export function createSchema(
  constraints: {
    isTitleUnique?: (title: string) => Promise<boolean>;
  } = {}
) {
  return z.object({
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
              message: "Email is already used",
            });
          });
        }
      }),
    description: z.string().optional(),
    redirectTo: z.string(),
    scopes: z.preprocess(
      (data) => (typeof data === "string" ? [data] : data),
      z
        .array(z.string(), {
          required_error: "You must select at least one scope",
        })
        .nonempty("You must select at least one scope")
    ),
  });
}

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
  const { organizationId } = ParamsSchema.parse(params);

  const formData = await request.formData();

  const formSchema = createSchema({
    isTitleUnique: async (title) => {
      const existingClient = await prisma.apiConnectionClient.findFirst({
        where: {
          organizationId,
          title,
        },
      });

      return !existingClient;
    },
  });

  const submission = await parse(formData, { schema: formSchema, async: true });

  if (!submission.value || submission.intent !== "submit") {
    console.log("submission", submission);
    return json(submission);
  }

  const {
    integrationIdentifier,
    integrationAuthMethod,
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
