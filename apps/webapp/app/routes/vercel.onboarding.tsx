import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json, redirect } from "@remix-run/server-runtime";
import { fromPromise } from "neverthrow";
import { useEffect, useState } from "react";
import { Form, useNavigation } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { BuildingOfficeIcon, FolderIcon } from "@heroicons/react/20/solid";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { BackgroundWrapper } from "~/components/BackgroundWrapper";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormTitle } from "~/components/primitives/FormTitle";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Select, SelectItem } from "~/components/primitives/Select";
import { ButtonSpinner } from "~/components/primitives/Spinner";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { confirmBasicDetailsPath, newProjectPath } from "~/utils/pathBuilder";
import { redirectWithErrorMessage } from "~/models/message.server";
import { generateVercelOAuthState } from "~/v3/vercel/vercelOAuthState.server";

const LoaderParamsSchema = z.object({
  organizationId: z.string().optional().nullable(),
  code: z.string().optional().nullable(),
  configurationId: z.string().optional().nullable(),
  next: z.string().optional().nullable(),
  error: z.string().optional().nullable(),
});

const SelectOrgActionSchema = z.object({
  action: z.literal("select-org"),
  organizationId: z.string(),
  code: z.string(),
  configurationId: z.string().optional().nullable(),
  next: z.string().optional(),
});

const SelectProjectActionSchema = z.object({
  action: z.literal("select-project"),
  projectId: z.string(),
  organizationId: z.string(),
  code: z.string(),
  configurationId: z.string().optional().nullable(),
  next: z.string().optional().nullable(),
});

const ActionSchema = z.discriminatedUnion("action", [
  SelectOrgActionSchema,
  SelectProjectActionSchema,
]);

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const url = new URL(request.url);

  const params = LoaderParamsSchema.safeParse({
    organizationId: url.searchParams.get("organizationId"),
    code: url.searchParams.get("code"),
    configurationId: url.searchParams.get("configurationId"),
    next: url.searchParams.get("next"),
    error: url.searchParams.get("error"),
  });

  if (!params.success) {
    logger.error("Invalid params for Vercel onboarding", { error: params.error });
    throw redirectWithErrorMessage(
      "/",
      request,
      "Invalid installation parameters. Please try again from Vercel."
    );
  }

  const { error } = params.data;
  if (error === "expired") {
    return typedjson({
      step: "error" as const,
      error: "Your installation session has expired. Please start the installation again.",
      code: params.data.code ?? null,
      configurationId: params.data.configurationId ?? null,
      next: params.data.next ?? null,
    });
  }

  if (!params.data.code) {
    logger.error("Missing code parameter for Vercel onboarding");
    throw redirectWithErrorMessage(
      "/",
      request,
      "Invalid installation parameters. Please try again from Vercel."
    );
  }

  const code = params.data.code;

  const organizations = await prisma.organization.findMany({
    where: {
      members: {
        some: { userId },
      },
      deletedAt: null,
    },
    select: {
      id: true,
      title: true,
      slug: true,
      projects: {
        where: {
          deletedAt: null,
        },
        select: {
          id: true,
          name: true,
          slug: true,
        },
        orderBy: {
          createdAt: "asc",
        },
      },
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  // New user: no organizations
  if (organizations.length === 0) {
    const onboardingParams = new URLSearchParams();
    onboardingParams.set("code", code);
    if (params.data.configurationId) {
      onboardingParams.set("configurationId", params.data.configurationId);
    }
    onboardingParams.set("integration", "vercel");
    if (params.data.next) {
      onboardingParams.set("next", params.data.next);
    }
    throw redirect(`${confirmBasicDetailsPath()}?${onboardingParams.toString()}`);
  }

  // If organizationId is provided, show project selection
  if (params.data.organizationId) {
    const organization = organizations.find((org) => org.id === params.data.organizationId);

    if (!organization) {
      logger.error("Organization not found or access denied", {
        organizationId: params.data.organizationId,
        userId,
      });
      throw redirectWithErrorMessage(
        "/",
        request,
        "Organization not found. Please try again."
      );
    }

    return typedjson({
      step: "project" as const,
      organization,
      organizations,
      code: code,
      configurationId: params.data.configurationId ?? null,
      next: params.data.next ?? null,
    });
  }

  return typedjson({
    step: "org" as const,
    organizations,
    code: code,
    configurationId: params.data.configurationId ?? null,
    next: params.data.next ?? null,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const formData = await request.formData();

  const submission = ActionSchema.safeParse({
    action: formData.get("action"),
    organizationId: formData.get("organizationId"),
    projectId: formData.get("projectId"),
    code: formData.get("code"),
    configurationId: formData.get("configurationId"),
    next: formData.get("next"),
  });

  if (!submission.success) {
    return json({ error: "Invalid submission" }, { status: 400 });
  }

  const { code, configurationId, next } = submission.data;

  // Handle org selection
  if (submission.data.action === "select-org") {
    const { organizationId } = submission.data;

    const projectParams = new URLSearchParams();
    projectParams.set("organizationId", organizationId);
    projectParams.set("code", code);
    if (configurationId) {
      projectParams.set("configurationId", configurationId);
    }
    if (next) {
      projectParams.set("next", next);
    }

    return redirect(`/vercel/onboarding?${projectParams.toString()}`);
  }

  // Handle project selection
  const { projectId, organizationId } = submission.data;

  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      organizationId,
      deletedAt: null,
      organization: {
        members: { some: { userId } },
      },
    },
    include: {
      organization: true,
    },
  });

  if (!project) {
    logger.error("Project not found or access denied", { projectId, userId });
    return json({ error: "Project not found" }, { status: 404 });
  }

  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      projectId: project.id,
      slug: "prod",
      archivedAt: null,
    },
  });

  if (!environment) {
    logger.error("Environment not found", { projectId: project.id });
    return json({ error: "Environment not found" }, { status: 404 });
  }

  const stateResult = await fromPromise(
    generateVercelOAuthState({
      organizationId: project.organizationId,
      projectId: project.id,
      environmentSlug: environment.slug,
      organizationSlug: project.organization.slug,
      projectSlug: project.slug,
    }),
    (error) => error
  );

  if (stateResult.isErr()) {
    logger.error("Failed to generate Vercel OAuth state", { error: stateResult.error });
    return json({ error: "Failed to generate installation state" }, { status: 500 });
  }

  const params = new URLSearchParams();
  params.set("state", stateResult.value);
  params.set("code", code);
  if (configurationId) {
    params.set("configurationId", configurationId);
  }
  params.set("origin", "marketplace");
  if (next) {
    params.set("next", next);
  }

  return redirect(`/vercel/connect?${params.toString()}`, 303);
}

export default function VercelOnboardingPage() {
  const data = useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [isInstalling, setIsInstalling] = useState(false);

  // Reset isInstalling when navigation returns to idle (e.g. on error)
  useEffect(() => {
    if (navigation.state === "idle" && isInstalling) {
      setIsInstalling(false);
    }
  }, [navigation.state, isInstalling]);

  if (data.step === "error") {
    return (
      <AppContainer className="bg-charcoal-900">
        <BackgroundWrapper>
          <MainCenteredContainer className="max-w-[26rem] rounded-lg border border-grid-bright bg-background-dimmed p-5 shadow-lg">
            <FormTitle title="Installation Expired" description={data.error} />
            <Button
              variant="primary/medium"
              onClick={() => window.close()}
              className="w-full"
            >
              Close
            </Button>
          </MainCenteredContainer>
        </BackgroundWrapper>
      </AppContainer>
    );
  }

  if (data.step === "org") {
    const newOrgUrl = (() => {
      const params = new URLSearchParams();
      params.set("code", data.code);
      if (data.configurationId) {
        params.set("configurationId", data.configurationId);
      }
      params.set("integration", "vercel");
      if (data.next) {
        params.set("next", data.next);
      }
      return `/orgs/new?${params.toString()}`;
    })();

    return (
      <AppContainer className="bg-charcoal-900">
        <BackgroundWrapper>
          <MainCenteredContainer className="max-w-[26rem] rounded-lg border border-grid-bright bg-background-dimmed p-5 shadow-lg">
            <FormTitle
              LeadingIcon={<BuildingOfficeIcon className="size-7 text-indigo-500" />}
              title="Select Organization"
              description="Choose which organization to install the Vercel integration into."
            />
            <Form method="post">
              <input type="hidden" name="action" value="select-org" />
              <input type="hidden" name="code" value={data.code} />
              {data.configurationId && (
                <input type="hidden" name="configurationId" value={data.configurationId} />
              )}
              {data.next && <input type="hidden" name="next" value={data.next} />}

              <Fieldset>
                <InputGroup>
                  <Label>Organization</Label>
                  <Select
                    name="organizationId"
                    placeholder="Choose an organization"
                    required
                    variant="tertiary/medium"
                    dropdownIcon
                    defaultValue={data.organizations[0]?.id}
                    text={(v) =>
                      typeof v === "string"
                        ? data.organizations.find((o) => o.id === v)?.title || "Choose an organization"
                        : "Choose an organization"
                    }
                  >
                    {data.organizations.map((org) => (
                      <SelectItem key={org.id} value={org.id}>
                        {org.title}
                      </SelectItem>
                    ))}
                  </Select>
                </InputGroup>
                <FormButtons
                  confirmButton={
                    <div className="flex items-center gap-2">
                      <LinkButton to={newOrgUrl} variant="tertiary/small">
                        + New Organization
                      </LinkButton>
                      <Button type="submit" variant="primary/small">
                        Continue
                      </Button>
                    </div>
                  }
                />
              </Fieldset>
            </Form>
          </MainCenteredContainer>
        </BackgroundWrapper>
      </AppContainer>
    );
  }

  const newProjectUrl = (() => {
    const params = new URLSearchParams();
    params.set("code", data.code);
    if (data.configurationId) {
      params.set("configurationId", data.configurationId);
    }
    params.set("integration", "vercel");
    params.set("organizationId", data.organization.id);
    if (data.next) {
      params.set("next", data.next);
    }
    return `${newProjectPath({ slug: data.organization.slug })}?${params.toString()}`;
  })();

  const isLoading = isSubmitting || isInstalling;

  return (
    <AppContainer className="bg-charcoal-900">
      <BackgroundWrapper>
        <MainCenteredContainer className="max-w-[26rem] rounded-lg border border-grid-bright bg-background-dimmed p-5 shadow-lg">
          <FormTitle
            LeadingIcon={<FolderIcon className="size-7 text-indigo-500" />}
            title="Select Project"
            description={`Choose which project in "${data.organization.title}" to install the Vercel integration into.`}
          />
          <Form method="post" onSubmit={() => setIsInstalling(true)}>
            <input type="hidden" name="action" value="select-project" />
            <input type="hidden" name="organizationId" value={data.organization.id} />
            <input type="hidden" name="code" value={data.code} />
            {data.configurationId && (
              <input type="hidden" name="configurationId" value={data.configurationId} />
            )}
            {data.next && <input type="hidden" name="next" value={data.next} />}

            <Fieldset>
              <InputGroup>
                <Label>Project</Label>
                <Select
                  name="projectId"
                  placeholder="Choose a project"
                  required
                  variant="tertiary/medium"
                  dropdownIcon
                  defaultValue={data.organization.projects[0]?.id}
                  text={(v) =>
                    typeof v === "string"
                      ? data.organization.projects.find((p) => p.id === v)?.name || "Choose a project"
                      : "Choose a project"
                  }
                >
                  {data.organization.projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </Select>
              </InputGroup>
              <FormButtons
                confirmButton={
                  <div className="flex items-center gap-2">
                    <LinkButton to={newProjectUrl} variant="tertiary/small" disabled={isLoading}>
                      + New Project
                    </LinkButton>
                    <Button
                      type="submit"
                      variant="primary/small"
                      disabled={isLoading}
                      TrailingIcon={isLoading ? ButtonSpinner : undefined}
                    >
                      {isLoading ? "Continuing…" : "Continue"}
                    </Button>
                  </div>
                }
              />
            </Fieldset>
          </Form>
        </MainCenteredContainer>
      </BackgroundWrapper>
    </AppContainer>
  );
}
