import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { FolderIcon } from "@heroicons/react/20/solid";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Form, useNavigation } from "@remix-run/react";
import { redirect, typedjson, useTypedActionData, useTypedLoaderData } from "remix-typedjson";
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
import { ButtonSpinner } from "~/components/primitives/Spinner";
import { prisma } from "~/db.server";
import { featuresForRequest } from "~/features.server";
import { useFeatures } from "~/hooks/useFeatures";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { createProject } from "~/models/project.server";
import { requireUserId } from "~/services/session.server";
import {
  OrganizationParamsSchema,
  organizationPath,
  v3ProjectPath,
  selectPlanPath,
} from "~/utils/pathBuilder";
import { isSubmissionResult } from "~/utils/conformTo";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const organization = await prisma.organization.findFirst({
    where: { slug: organizationSlug, members: { some: { userId } } },
    select: {
      id: true,
      title: true,
      v3Enabled: true,
      v2Enabled: true,
      hasRequestedV3: true,
      _count: {
        select: {
          projects: {
            where: {
              deletedAt: null,
            },
          },
        },
      },
    },
  });

  if (!organization) {
    throw new Response(null, { status: 404, statusText: "Organization not found" });
  }

  //if you don't have v3 access, you must select a plan
  const { isManagedCloud } = featuresForRequest(request);
  if (isManagedCloud && !organization.v3Enabled) {
    return redirect(selectPlanPath({ slug: organizationSlug }));
  }

  const url = new URL(request.url);

  const message = url.searchParams.get("message");

  return typedjson({
    organization: {
      id: organization.id,
      title: organization.title,
      slug: organizationSlug,
      projectsCount: organization._count.projects,
      v3Enabled: organization.v3Enabled,
      v2Enabled: organization.v2Enabled,
      hasRequestedV3: organization.hasRequestedV3,
    },
    defaultVersion: url.searchParams.get("version") ?? "v2",
    message: message ? decodeURIComponent(message) : undefined,
  });
}

const schema = z.object({
  projectName: z.string().min(3, "Project name must have at least 3 characters").max(50),
  projectVersion: z.enum(["v2", "v3"]),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug } = params;
  invariant(organizationSlug, "organizationSlug is required");

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value || submission.intent !== "submit") {
    return typedjson(submission);
  }

  try {
    const project = await createProject({
      organizationSlug: organizationSlug,
      name: submission.value.projectName,
      userId,
      version: submission.value.projectVersion,
    });

    return redirectWithSuccessMessage(
      v3ProjectPath(project.organization, project),
      request,
      `${submission.value.projectName} created`
    );
  } catch (error: any) {
    return typedjson({ errors: { body: error.message } }, { status: 400 });
  }
};

export default function Page() {
  const { organization, message } = useTypedLoaderData<typeof loader>();

  const _lastSubmission = useTypedActionData<typeof action>();
  const lastSubmission = isSubmissionResult(_lastSubmission) ? _lastSubmission : undefined;

  const canCreateV3Projects = organization.v3Enabled;

  const [form, { projectName, projectVersion }] = useForm({
    id: "create-project",
    lastSubmission,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
  });

  const navigation = useNavigation();
  const isLoading = navigation.state === "submitting" || navigation.state === "loading";

  return (
    <MainCenteredContainer>
      <div>
        <FormTitle
          LeadingIcon={<FolderIcon className="size-7 text-indigo-500" />}
          title="Create a new project"
          description={`This will create a new project in your "${organization.title}" organization.`}
        />
        <Form method="post" {...form.props}>
          {message && (
            <Callout variant="success" className="mb-4">
              {message}
            </Callout>
          )}
          <Fieldset>
            <InputGroup>
              <Label htmlFor={projectName.id}>Project name</Label>
              <Input
                {...conform.input(projectName, { type: "text" })}
                placeholder="Your project name"
                icon={FolderIcon}
                autoFocus
              />
              <FormError id={projectName.errorId}>{projectName.error}</FormError>
            </InputGroup>
            {canCreateV3Projects ? (
              <input {...conform.input(projectVersion, { type: "hidden" })} value={"v3"} />
            ) : (
              <input {...conform.input(projectVersion, { type: "hidden" })} value={"v2"} />
            )}
            <FormButtons
              confirmButton={
                <Button
                  type="submit"
                  variant={"primary/small"}
                  disabled={isLoading}
                  TrailingIcon={isLoading ? ButtonSpinner : undefined}
                >
                  {isLoading ? "Creating…" : "Create"}
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
