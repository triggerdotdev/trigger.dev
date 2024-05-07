import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import type { ActionFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { z } from "zod";
import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Select, SelectItem } from "~/components/primitives/Select";
import { prisma } from "~/db.server";
import { useFeatures } from "~/hooks/useFeatures";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { createProject } from "~/models/project.server";
import { requireUserId } from "~/services/session.server";
import { OrganizationParamsSchema, organizationPath, projectPath } from "~/utils/pathBuilder";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const organization = await prisma.organization.findUnique({
    where: { slug: organizationSlug, members: { some: { userId } } },
    select: {
      id: true,
      title: true,
      v3Enabled: true,
      _count: {
        select: {
          projects: {
            where: { deletedAt: null },
          },
        },
      },
    },
  });

  if (!organization) {
    throw new Response(null, { status: 404, statusText: "Organization not found" });
  }

  const url = new URL(request.url);

  return typedjson({
    organization: {
      id: organization.id,
      title: organization.title,
      slug: organizationSlug,
      projectsCount: organization._count.projects,
      v3Enabled: organization.v3Enabled,
    },
    defaultVersion: url.searchParams.get("version") ?? "v2",
  });
}

const schema = z.object({
  projectName: z.string().min(3, "Project name must have at least 3 characters").max(50),
  projectVersion: z.enum(["v2", "v3"]),
});

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { organizationSlug } = params;
  invariant(organizationSlug, "organizationSlug is required");

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  try {
    const project = await createProject({
      organizationSlug: organizationSlug,
      name: submission.value.projectName,
      userId,
      version: submission.value.projectVersion,
    });

    return redirectWithSuccessMessage(
      projectPath(project.organization, project),
      request,
      `${submission.value.projectName} created`
    );
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

export default function NewOrganizationPage() {
  const { organization, defaultVersion } = useTypedLoaderData<typeof loader>();
  const lastSubmission = useActionData();
  const { v3Enabled } = useFeatures();

  const canCreateV3Projects = organization.v3Enabled && v3Enabled;

  const [form, { projectName, projectVersion }] = useForm({
    id: "create-project",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
  });

  return (
    <MainCenteredContainer>
      <div>
        <FormTitle
          LeadingIcon="folder"
          title="Create a new project"
          description={`This will create a new project in your "${organization.title}" organization. `}
        />
        <Form method="post" {...form.props}>
          {organization.projectsCount === 0 && (
            <Callout variant="info" className="mb-4">
              Organizations require at least one project, please create one to continue.
            </Callout>
          )}
          <Fieldset>
            <InputGroup>
              <Label htmlFor={projectName.id}>Project name</Label>
              <Input
                {...conform.input(projectName, { type: "text" })}
                placeholder="Your project name"
                icon="folder"
                autoFocus
              />
              <FormError id={projectName.errorId}>{projectName.error}</FormError>
            </InputGroup>
            {canCreateV3Projects ? (
              <InputGroup>
                <Label htmlFor={projectVersion.id}>Project version</Label>
                <Select
                  {...conform.select(projectVersion)}
                  defaultValue={undefined}
                  variant="tertiary/medium"
                  placeholder="Select version"
                  dropdownIcon
                  text={(value) => {
                    switch (value) {
                      case "v2":
                        return "Version 2";
                      case "v3":
                        return "Version 3";
                    }
                  }}
                >
                  <SelectItem value="v2">Version 2</SelectItem>
                  <SelectItem value="v3">Version 3 (Developer Preview)</SelectItem>
                </Select>
                <FormError id={projectVersion.errorId}>{projectVersion.error}</FormError>
              </InputGroup>
            ) : (
              <input {...conform.input(projectVersion, { type: "hidden" })} value="v2" />
            )}
            <FormButtons
              confirmButton={
                <Button type="submit" variant={"primary/small"}>
                  Create
                </Button>
              }
              cancelButton={
                organization.projectsCount > 0 ? (
                  <LinkButton to={organizationPath(organization)} variant={"tertiary/small"}>
                    Cancel
                  </LinkButton>
                ) : undefined
              }
            />
          </Fieldset>
        </Form>
      </div>
    </MainCenteredContainer>
  );
}
