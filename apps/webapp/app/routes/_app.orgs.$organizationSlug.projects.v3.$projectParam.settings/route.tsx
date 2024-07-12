import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { type ActionFunction, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { InlineCode } from "~/components/code/InlineCode";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Property, PropertyTable } from "~/components/primitives/PropertyTable";
import { prisma } from "~/db.server";
import { useProject } from "~/hooks/useProject";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { requireUserId } from "~/services/session.server";
import { v3ProjectPath } from "~/utils/pathBuilder";

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

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={`${project.name} project settings`} />

        <PageAccessories>
          <AdminDebugTooltip>
            <PropertyTable>
              <Property label="ID">
                <div className="flex items-center gap-2">
                  <Paragraph variant="extra-small/bright/mono">{project.id}</Paragraph>
                </div>
              </Property>
              <Property label="Org ID">
                <div className="flex items-center gap-2">
                  <Paragraph variant="extra-small/bright/mono">{project.organizationId}</Paragraph>
                </div>
              </Property>
            </PropertyTable>
          </AdminDebugTooltip>
        </PageAccessories>
      </NavBar>

      <PageBody>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-4">
            <Fieldset>
              <InputGroup>
                <Label>Project ref</Label>
                <ClipboardField value={project.ref} variant={"secondary/small"} />
                <Hint>
                  This goes in your{" "}
                  <InlineCode variant="extra-extra-small">trigger.config</InlineCode> file.
                </Hint>
              </InputGroup>
            </Fieldset>

            <Form method="post" {...renameForm.props} className="max-w-md">
              <input type="hidden" name="action" value="rename" />
              <Fieldset>
                <InputGroup>
                  <Label htmlFor={projectName.id}>Rename your project</Label>
                  <Input
                    {...conform.input(projectName, { type: "text" })}
                    defaultValue={project.name}
                    placeholder="Your project name"
                    icon="folder"
                    autoFocus
                  />
                  <FormError id={projectName.errorId}>{projectName.error}</FormError>
                </InputGroup>
                <FormButtons
                  confirmButton={
                    <Button
                      type="submit"
                      variant={"primary/small"}
                      disabled={isRenameLoading}
                      LeadingIcon={isRenameLoading ? "spinner-white" : undefined}
                    >
                      Rename project
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
