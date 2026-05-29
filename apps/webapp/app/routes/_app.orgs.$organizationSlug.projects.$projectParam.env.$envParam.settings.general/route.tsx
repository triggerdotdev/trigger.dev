import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { ExclamationTriangleIcon, FolderIcon, TrashIcon } from "@heroicons/react/20/solid";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { type ActionFunction, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { InlineCode } from "~/components/code/InlineCode";
import { MainHorizontallyCenteredContainer } from "~/components/layout/AppLayout";
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
import { SpinnerWhite } from "~/components/primitives/Spinner";
import { useProject } from "~/hooks/useProject";
import {
  redirectWithErrorMessage,
  redirectWithSuccessMessage,
} from "~/models/message.server";
import { ProjectSettingsService } from "~/services/projectSettings.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { organizationPath, v3ProjectPath } from "~/utils/pathBuilder";
import { useState } from "react";

function createSchema(
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
    return json({ errors: { body: "organizationSlug and projectParam are required" } }, { status: 400 });
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

  const projectSettingsService = new ProjectSettingsService();
  const membershipResultOrFail = await projectSettingsService.verifyProjectMembership(
    organizationSlug,
    projectParam,
    userId
  );

  if (membershipResultOrFail.isErr()) {
    return json({ errors: { body: membershipResultOrFail.error.type } }, { status: 404 });
  }

  const { projectId } = membershipResultOrFail.value;

  switch (submission.value.action) {
    case "rename": {
      const resultOrFail = await projectSettingsService.renameProject(
        projectId,
        submission.value.projectName
      );

      if (resultOrFail.isErr()) {
        switch (resultOrFail.error.type) {
          case "other":
          default: {
            resultOrFail.error.type satisfies "other";

            logger.error("Failed to rename project", {
              error: resultOrFail.error,
            });
            return json({ errors: { body: "Failed to rename project" } }, { status: 400 });
          }
        }
      }

      return redirectWithSuccessMessage(
        v3ProjectPath({ slug: organizationSlug }, { slug: projectParam }),
        request,
        `Project renamed to ${submission.value.projectName}`
      );
    }
    case "delete": {
      const resultOrFail = await projectSettingsService.deleteProject(projectId, userId);

      if (resultOrFail.isErr()) {
        switch (resultOrFail.error.type) {
          case "other":
          default: {
            resultOrFail.error.type satisfies "other";

            logger.error("Failed to delete project", {
              error: resultOrFail.error,
            });
            return redirectWithErrorMessage(
              v3ProjectPath({ slug: organizationSlug }, { slug: projectParam }),
              request,
              `Project ${projectParam} could not be deleted`
            );
          }
        }
      }

      return redirectWithSuccessMessage(
        organizationPath({ slug: organizationSlug }),
        request,
        "Project deleted"
      );
    }
  }
};

export default function GeneralSettingsPage() {
  const project = useProject();
  const lastSubmission = useActionData();
  const navigation = useNavigation();

  const [hasRenameFormChanges, setHasRenameFormChanges] = useState(false);

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

  const [deleteInputValue, setDeleteInputValue] = useState("");

  return (
    <MainHorizontallyCenteredContainer className="md:mt-6">
      <div className="flex flex-col gap-6">
        <div>
          <Header2 spacing>General</Header2>
          <div className="w-full rounded-sm border border-grid-dimmed p-4">
            <Fieldset className="mb-5">
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
              <Fieldset>
                <InputGroup fullWidth>
                  <Label htmlFor={projectName.id}>Project name</Label>
                  <Input
                    {...conform.input(projectName, { type: "text" })}
                    defaultValue={project.name}
                    placeholder="Project name"
                    icon={FolderIcon}
                    autoFocus
                    onChange={(e) => {
                      setHasRenameFormChanges(e.target.value !== project.name);
                    }}
                  />
                  <FormError id={projectName.errorId}>{projectName.error}</FormError>
                </InputGroup>
                <FormButtons
                  confirmButton={
                    <Button
                      type="submit"
                      name="action"
                      value="rename"
                      variant={"secondary/small"}
                      disabled={isRenameLoading || !hasRenameFormChanges}
                      LeadingIcon={isRenameLoading ? SpinnerWhite : undefined}
                    >
                      Save
                    </Button>
                  }
                />
              </Fieldset>
            </Form>
          </div>
        </div>

        <div>
          <Header2 spacing>Danger zone</Header2>
          <div className="w-full rounded-sm border border-rose-500/40 p-4">
            <Form method="post" {...deleteForm.props}>
              <Fieldset>
                <InputGroup fullWidth>
                  <Label htmlFor={projectSlug.id}>Delete project</Label>
                  <Input
                    {...conform.input(projectSlug, { type: "text" })}
                    placeholder="Your project slug"
                    icon={ExclamationTriangleIcon}
                    onChange={(e) => setDeleteInputValue(e.target.value)}
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
                      name="action"
                      value="delete"
                      variant={"danger/small"}
                      LeadingIcon={isDeleteLoading ? SpinnerWhite : TrashIcon}
                      leadingIconClassName="text-white"
                      disabled={isDeleteLoading || deleteInputValue !== project.slug}
                    >
                      Delete
                    </Button>
                  }
                />
              </Fieldset>
            </Form>
          </div>
        </div>
      </div>
    </MainHorizontallyCenteredContainer>
  );
}
