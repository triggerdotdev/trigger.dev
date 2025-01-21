import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { Form, MetaFunction, useActionData, useNavigation } from "@remix-run/react";
import { ActionFunction, json } from "@remix-run/server-runtime";
import { redirect } from "remix-typedjson";
import { z } from "zod";
import { InlineCode } from "~/components/code/InlineCode";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { prisma } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import {
  clearCurrentProjectId,
  commitCurrentProjectSession,
} from "~/services/currentProject.server";
import { DeleteOrganizationService } from "~/services/deleteOrganization.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { organizationPath, organizationSettingsPath, rootPath } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Organization settings | Trigger.dev`,
    },
  ];
};

export function createSchema(
  constraints: {
    getSlugMatch?: (slug: string) => { isMatch: boolean; organizationSlug: string };
  } = {}
) {
  return z.discriminatedUnion("action", [
    z.object({
      action: z.literal("rename"),
      organizationName: z
        .string()
        .min(3, "Organization name must have at least 3 characters")
        .max(50),
    }),
    z.object({
      action: z.literal("delete"),
      organizationSlug: z.string().superRefine((slug, ctx) => {
        if (constraints.getSlugMatch === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: conform.VALIDATION_UNDEFINED,
          });
        } else {
          const { isMatch, organizationSlug } = constraints.getSlugMatch(slug);
          if (isMatch) {
            return;
          }

          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `The slug must match ${organizationSlug}`,
          });
        }
      }),
    }),
  ]);
}

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { organizationSlug } = params;
  if (!organizationSlug) {
    return json({ errors: { body: "organizationSlug is required" } }, { status: 400 });
  }

  const formData = await request.formData();
  const schema = createSchema({
    getSlugMatch: (slug) => {
      return { isMatch: slug === organizationSlug, organizationSlug };
    },
  });
  const submission = parse(formData, { schema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  try {
    switch (submission.value.action) {
      case "rename": {
        await prisma.organization.update({
          where: {
            slug: organizationSlug,
            members: {
              some: {
                userId,
              },
            },
          },
          data: {
            title: submission.value.organizationName,
          },
        });

        return redirectWithSuccessMessage(
          organizationPath({ slug: organizationSlug }),
          request,
          `Organization renamed to ${submission.value.organizationName}`
        );
      }
      case "delete": {
        const deleteOrganizationService = new DeleteOrganizationService();
        try {
          await deleteOrganizationService.call({ organizationSlug, userId, request });

          //we need to clear the project from the session
          const removeProjectIdSession = await clearCurrentProjectId(request);
          return redirect(rootPath(), {
            headers: {
              "Set-Cookie": await commitCurrentProjectSession(removeProjectIdSession),
            },
          });
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
          logger.error("Organization could not be deleted", {
            error: errorMessage,
          });
          return redirectWithErrorMessage(
            organizationSettingsPath({ slug: organizationSlug }),
            request,
            errorMessage
          );
        }
      }
    }
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

export default function Page() {
  const organization = useOrganization();
  const lastSubmission = useActionData();
  const navigation = useNavigation();

  const [renameForm, { organizationName }] = useForm({
    id: "rename-organization",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    shouldRevalidate: "onSubmit",
    onValidate({ formData }) {
      return parse(formData, {
        schema: createSchema(),
      });
    },
  });

  const [deleteForm, { organizationSlug }] = useForm({
    id: "delete-organization",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    shouldValidate: "onInput",
    shouldRevalidate: "onSubmit",
    onValidate({ formData }) {
      return parse(formData, {
        schema: createSchema({
          getSlugMatch: (slug) => ({
            isMatch: slug === organization.slug,
            organizationSlug: organization.slug,
          }),
        }),
      });
    },
  });

  const isRenameLoading =
    navigation.formData?.get("action") === "rename" &&
    (navigation.state === "submitting" || navigation.state === "loading");

  const isDeleteLoading =
    navigation.formData?.get("action") === "delete" &&
    (navigation.state === "submitting" || navigation.state === "loading");

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={`${organization.title} organization settings`} />
      </NavBar>

      <PageBody>
        <div className="flex flex-col gap-4">
          <div>
            <Form method="post" {...renameForm.props} className="max-w-md">
              <input type="hidden" name="action" value="rename" />
              <Fieldset>
                <InputGroup>
                  <Label htmlFor={organizationName.id}>Rename your organization</Label>
                  <Input
                    {...conform.input(organizationName, { type: "text" })}
                    defaultValue={organization.title}
                    placeholder="Your organization name"
                    icon="folder"
                    autoFocus
                  />
                  <FormError id={organizationName.errorId}>{organizationName.error}</FormError>
                </InputGroup>
                <FormButtons
                  confirmButton={
                    <Button
                      type="submit"
                      variant={"primary/small"}
                      disabled={isRenameLoading}
                      LeadingIcon={isRenameLoading ? "spinner-white" : undefined}
                    >
                      Rename organization
                    </Button>
                  }
                />
              </Fieldset>
            </Form>
          </div>

          <div>
            <Header2 spacing>Danger zone</Header2>
            <Form
              method="post"
              {...deleteForm.props}
              className="max-w-md rounded-sm border border-rose-500/40"
            >
              <input type="hidden" name="action" value="delete" />
              <Fieldset className="p-4">
                <InputGroup>
                  <Label htmlFor={organizationSlug.id}>Delete organization</Label>
                  <Input
                    {...conform.input(organizationSlug, { type: "text" })}
                    placeholder="Your organization slug"
                    icon="warning"
                    autoFocus
                  />
                  <FormError id={organizationSlug.errorId}>{organizationSlug.error}</FormError>
                  <FormError>{deleteForm.error}</FormError>
                  <Hint>
                    This change is irreversible, so please be certain. Type in the Organization slug{" "}
                    <InlineCode variant="extra-small">{organization.slug}</InlineCode> and then
                    press Delete.
                  </Hint>
                </InputGroup>
                <FormButtons
                  confirmButton={
                    <Button
                      type="submit"
                      variant={"danger/small"}
                      LeadingIcon={isDeleteLoading ? "spinner-white" : "trash-can"}
                      leadingIconClassName="text-white"
                      disabled={isDeleteLoading}
                    >
                      Delete organization
                    </Button>
                  }
                />
              </Fieldset>
            </Form>
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}
