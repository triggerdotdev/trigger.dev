import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { FolderIcon } from "@heroicons/react/20/solid";
import { Form, type MetaFunction, useActionData, useNavigation } from "@remix-run/react";
import { type ActionFunction, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { InlineCode } from "~/components/code/InlineCode";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import { SpinnerWhite } from "~/components/primitives/Spinner";
import { prisma } from "~/db.server";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { DeleteProjectService } from "~/services/deleteProject.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { organizationPath, v3ProjectPath } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Project settings | Trigger.dev`,
    },
  ];
};

export function createSchema(
  constraints: {
    getSlugMatch?: (slug: string) => { isMatch: boolean; projectSlug: string };
  } = {}
) {
  return z.discriminatedUnion("action", [
    z.object({
      action: z.literal("rename"),
      projectName: z.string().min(3, "Project name must have at least 3 characters").max(50),
    }),
    z.object({
      action: z.literal("delete"),
      projectSlug: z.string().superRefine((slug, ctx) => {
        if (constraints.getSlugMatch === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: conform.VALIDATION_UNDEFINED,
          });
        } else {
          const { isMatch, projectSlug } = constraints.getSlugMatch(slug);
          if (isMatch) {
            return;
          }

          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `The slug must match ${projectSlug}`,
          });
        }
      }),
    }),
  ]);
}

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = params;
  if (!organizationSlug || !projectParam) {
    return json({ errors: { body: "organizationSlug is required" } }, { status: 400 });
  }

  const formData = await request.formData();

  const schema = createSchema({
    getSlugMatch: (slug) => {
      return { isMatch: slug === projectParam, projectSlug: projectParam };
    },
  });
  const submission = parse(formData, { schema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  try {
    switch (submission.value.action) {
      case "rename": {
        await prisma.project.update({
          where: {
            slug: projectParam,
            organization: {
              members: {
                some: {
                  userId,
                },
              },
            },
          },
          data: {
            name: submission.value.projectName,
          },
        });

        return redirectWithSuccessMessage(
          v3ProjectPath({ slug: organizationSlug }, { slug: projectParam }),
          request,
          `Project renamed to ${submission.value.projectName}`
        );
      }
      case "delete": {
        const deleteProjectService = new DeleteProjectService();
        try {
          await deleteProjectService.call({ projectSlug: projectParam, userId });

          return redirectWithSuccessMessage(
            organizationPath({ slug: organizationSlug }),
            request,
            "Project deleted"
          );
        } catch (error: unknown) {
          logger.error("Project could not be deleted", {
            error: error instanceof Error ? error.message : JSON.stringify(error),
          });
          return redirectWithErrorMessage(
            v3ProjectPath({ slug: organizationSlug }, { slug: projectParam }),
            request,
            `Project ${projectParam} could not be deleted`
          );
        }
      }
    }
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

export default function Page() {
  const project = useProject();
  const lastSubmission = useActionData();
  const navigation = useNavigation();

  const [renameForm, { projectName }] = useForm({
    id: "rename-project",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    shouldRevalidate: "onSubmit",
    onValidate({ formData }) {
      return parse(formData, {
        schema: createSchema(),
      });
    },
  });

  const isRenameLoading =
    navigation.formData?.get("action") === "rename" &&
    (navigation.state === "submitting" || navigation.state === "loading");

  const [deleteForm, { projectSlug }] = useForm({
    id: "delete-project",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    shouldValidate: "onInput",
    shouldRevalidate: "onSubmit",
    onValidate({ formData }) {
      return parse(formData, {
        schema: createSchema({
          getSlugMatch: (slug) => ({ isMatch: slug === project.slug, projectSlug: project.slug }),
        }),
      });
    },
  });

  const isDeleteLoading =
    navigation.formData?.get("action") === "delete" &&
    (navigation.state === "submitting" || navigation.state === "loading");

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={`${project.name} project settings`} />

        <PageAccessories>
          <AdminDebugTooltip>
            <Property.Table>
              <Property.Item>
                <Property.Label>ID</Property.Label>
                <Property.Value>{project.id}</Property.Value>
                <div className="flex items-center gap-2">
                  <Paragraph variant="extra-small/bright/mono">{project.id}</Paragraph>
                </div>
              </Property.Item>
              <Property.Item>
                <Property.Label>Org ID</Property.Label>
                <Property.Value>{project.organizationId}</Property.Value>
              </Property.Item>
            </Property.Table>
          </AdminDebugTooltip>
        </PageAccessories>
      </NavBar>

      <PageBody>
        <MainHorizontallyCenteredContainer>
          <div className="mb-3 border-b border-grid-dimmed pb-3">
            <Header2>Project settings</Header2>
          </div>
          <div className="flex flex-col gap-6">
            <Fieldset>
              <InputGroup fullWidth>
                <Label>Project ref</Label>
                <ClipboardField value={project.externalRef} variant={"secondary/medium"} />
                <Hint>
                  This goes in your{" "}
                  <InlineCode variant="extra-extra-small">trigger.config</InlineCode> file.
                </Hint>
              </InputGroup>
            </Fieldset>

            <Form method="post" {...renameForm.props}>
              <input type="hidden" name="action" value="rename" />
              <Fieldset className="gap-y-0">
                <InputGroup fullWidth>
                  <Label htmlFor={projectName.id}>Rename your project</Label>
                  <Input
                    {...conform.input(projectName, { type: "text" })}
                    defaultValue={project.name}
                    placeholder="Your project name"
                    icon={FolderIcon}
                    autoFocus
                  />
                  <FormError id={projectName.errorId}>{projectName.error}</FormError>
                </InputGroup>
                <FormButtons
                  confirmButton={
                    <Button
                      type="submit"
                      variant={"secondary/small"}
                      disabled={isRenameLoading}
                      LeadingIcon={isRenameLoading ? SpinnerWhite : undefined}
                    >
                      Rename project
                    </Button>
                  }
                  className="border-t-0"
                />
              </Fieldset>
            </Form>

            <div>
              <Header2 spacing>Danger zone</Header2>
              <Form
                method="post"
                {...deleteForm.props}
                className="w-full rounded-sm border border-rose-500/40"
              >
                <input type="hidden" name="action" value="delete" />
                <Fieldset className="p-4">
                  <InputGroup>
                    <Label htmlFor={projectSlug.id}>Delete project</Label>
                    <Input
                      {...conform.input(projectSlug, { type: "text" })}
                      placeholder="Your project slug"
                      icon="warning"
                    />
                    <FormError id={projectSlug.errorId}>{projectSlug.error}</FormError>
                    <FormError>{deleteForm.error}</FormError>
                    <Hint>
                      This change is irreversible, so please be certain. Type in the Project slug
                      <InlineCode variant="extra-small">{project.slug}</InlineCode> and then press
                      Delete.
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
                        Delete project
                      </Button>
                    }
                  />
                </Fieldset>
              </Form>
            </div>
          </div>
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}
