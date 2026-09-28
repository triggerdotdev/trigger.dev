import { getFormProps, getInputProps, useForm } from "@conform-to/react";
import { parseWithZod } from "@conform-to/zod/v4";
import { FolderIcon } from "@heroicons/react/20/solid";
import {
  json,
  redirectDocument,
  type ActionFunction,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { z } from "zod";
import { BackgroundWrapper } from "~/components/BackgroundWrapper";
import { Feedback } from "~/components/Feedback";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";

import { prisma } from "~/db.server";
import { featuresForRequest } from "~/features.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { createProject, ExceededProjectLimitError } from "~/models/project.server";
import { requireUserId } from "~/services/session.server";
import {
  newProjectPath,
  OrganizationParamsSchema,
  organizationPath,
  selectPlanPath,
  v3ProjectPath,
} from "~/utils/pathBuilder";
import { generateVercelOAuthState } from "~/v3/vercel/vercelOAuthState.server";
import { pageMeta } from "~/utils/pageTitle";

export const meta = pageMeta("New project");

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const organization = await prisma.organization.findFirst({
    where: { slug: organizationSlug, members: { some: { userId } } },
    select: {
      id: true,
      title: true,
      isActivated: true,
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

  const { isManagedCloud } = featuresForRequest(request);
  if (isManagedCloud && !organization.isActivated) {
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
      isActivated: organization.isActivated,
    },
    defaultVersion: url.searchParams.get("version") ?? "v2",
    message: message ? decodeURIComponent(message) : undefined,
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
  const submission = parseWithZod(formData, { schema });

  if (submission.status !== "success") {
    return json(submission.reply());
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const configurationId = url.searchParams.get("configurationId");
  const next = url.searchParams.get("next");

  try {
    const project = await createProject({
      organizationSlug: organizationSlug,
      name: submission.value.projectName,
      userId,
      version: submission.value.projectVersion,
    });

    if (code && configurationId) {
      const environment = await prisma.runtimeEnvironment.findFirst({
        where: {
          projectId: project.id,
          slug: "prod",
          archivedAt: null,
        },
      });

      if (!environment) {
        return redirectWithErrorMessage(
          newProjectPath({ slug: organizationSlug }),
          request,
          "Failed to find project environment."
        );
      }

      const state = await generateVercelOAuthState({
        organizationId: project.organization.id,
        projectId: project.id,
        environmentSlug: environment.slug,
        organizationSlug: project.organization.slug,
        projectSlug: project.slug,
      });

      const params = new URLSearchParams({
        state,
        code,
        configurationId,
        origin: "marketplace",
      });
      if (next) {
        params.set("next", next);
      }
      return redirectDocument(`/vercel/connect?${params.toString()}`);
    }

    const destination = v3ProjectPath(project.organization, project);
    const response = await redirectWithSuccessMessage(
      destination,
      request,
      `${submission.value.projectName} created`
    );

    return redirectDocument(destination, { headers: response.headers });
  } catch (error) {
    if (error instanceof ExceededProjectLimitError) {
      return redirectWithErrorMessage(
        newProjectPath({ slug: organizationSlug }),
        request,
        error.message,
        {
          title: "Failed to create project",
          action: {
            label: "Request more projects",
            variant: "secondary/small",
            action: { type: "help", feedbackType: "help" },
          },
        }
      );
    }

    return redirectWithErrorMessage(
      newProjectPath({ slug: organizationSlug }),
      request,
      error instanceof Error ? error.message : "Something went wrong",
      { ephemeral: false }
    );
  }
};

export default function Page() {
  const { organization, message } = useTypedLoaderData<typeof loader>();
  const lastSubmission = useActionData();

  const canCreateV3Projects = organization.isActivated;

  const [form, { projectName, projectVersion }] = useForm({
    id: "create-project",
    lastResult: lastSubmission as any,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema });
    },
  });

  const navigation = useNavigation();
  const isLoading = navigation.state === "submitting" || navigation.state === "loading";

  return (
    <AppContainer className="bg-background-deep">
      <BackgroundWrapper>
        <MainCenteredContainer
          variant="onboarding"
          className="max-w-116 rounded-lg border border-grid-bright bg-background-dimmed p-5 shadow-lg"
        >
          <div>
            <FormTitle
              LeadingIcon={<FolderIcon className="size-7 text-indigo-500" />}
              title="Create a new project"
              description={`This will create a new project in your "${organization.title}" organization.`}
            />
            <Form method="post" {...getFormProps(form)}>
              {message && (
                <Callout variant="success" className="mb-4">
                  {message}
                </Callout>
              )}
              <Fieldset>
                <InputGroup>
                  <Label htmlFor={projectName.id}>
                    Project name <span className="text-text-bright">*</span>
                  </Label>
                  <Input
                    {...getInputProps(projectName, { type: "text" })}
                    placeholder="Your project name"
                    icon={FolderIcon}
                    autoFocus
                  />
                  <FormError id={projectName.errorId}>{projectName.errors}</FormError>
                </InputGroup>
                {canCreateV3Projects ? (
                  <input
                    {...getInputProps(projectVersion, { type: "hidden", value: false })}
                    defaultValue={"v3"}
                  />
                ) : (
                  <input
                    {...getInputProps(projectVersion, { type: "hidden", value: false })}
                    defaultValue={"v2"}
                  />
                )}

                <FormButtons
                  confirmButton={
                    <Button type="submit" variant={"primary/small"} isLoading={isLoading}>
                      Create
                    </Button>
                  }
                  cancelButton={
                    organization.projectsCount > 0 ? (
                      <LinkButton to={organizationPath(organization)} variant={"secondary/small"}>
                        Cancel
                      </LinkButton>
                    ) : undefined
                  }
                />
              </Fieldset>
            </Form>
          </div>
          <Feedback />
        </MainCenteredContainer>
      </BackgroundWrapper>
    </AppContainer>
  );
}
