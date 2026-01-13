import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json, redirect } from "@remix-run/server-runtime";
import { Form, useLoaderData, useNavigation } from "@remix-run/react";
import { z } from "zod";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { BackgroundWrapper } from "~/components/BackgroundWrapper";
import { Button } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Select, SelectItem, SelectGroup, SelectGroupLabel } from "~/components/primitives/Select";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { confirmBasicDetailsPath, v3ProjectSettingsPath, newProjectPath } from "~/utils/pathBuilder";
import { redirectWithErrorMessage } from "~/models/message.server";
import { VercelIntegrationRepository } from "~/models/vercelIntegration.server";
import { env } from "~/env.server";


const LoaderParamsSchema = z.object({
  organizationId: z.string().optional().nullable(),
  code: z.string(),
  configurationId: z.string(),
  next: z.string().optional().nullable(),
});

const SelectOrgActionSchema = z.object({
  action: z.literal("select-org"),
  organizationId: z.string(),
  code: z.string(),
  configurationId: z.string(),
  next: z.string().optional(),
});

const SelectProjectActionSchema = z.object({
  action: z.literal("select-project"),
  projectId: z.string(),
  organizationId: z.string(),
  code: z.string(),
  configurationId: z.string(),
  next: z.string().optional().nullable(),
});

const ActionSchema = z.discriminatedUnion("action", [
  SelectOrgActionSchema,
  SelectProjectActionSchema,
]);

type TokenResponse = {
  accessToken: string;
  tokenType: string;
  teamId?: string;
  userId?: string;
  raw: Record<string, unknown>;
};

async function exchangeCodeForToken(code: string): Promise<TokenResponse | null> {
  const clientId = env.VERCEL_INTEGRATION_CLIENT_ID;
  const clientSecret = env.VERCEL_INTEGRATION_CLIENT_SECRET;
  const redirectUri = `${env.APP_ORIGIN}/callback/vercel`;

  if (!clientId || !clientSecret) {
    logger.error("Vercel integration not configured");
    return null;
  }

  try {
    const response = await fetch("https://api.vercel.com/v2/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("Failed to exchange Vercel OAuth code", {
        status: response.status,
        error: errorText,
      });
      return null;
    }

    const data = (await response.json()) as {
      access_token: string;
      token_type: string;
      team_id?: string;
      user_id?: string;
    };

    return {
      accessToken: data.access_token,
      tokenType: data.token_type,
      teamId: data.team_id,
      userId: data.user_id,
      raw: data as Record<string, unknown>,
    };
  } catch (error) {
    logger.error("Error exchanging Vercel OAuth code", { error });
    return null;
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const url = new URL(request.url);

  const params = LoaderParamsSchema.safeParse({
    organizationId: url.searchParams.get("organizationId"),
    code: url.searchParams.get("code"),
    configurationId: url.searchParams.get("configurationId"),
    next: url.searchParams.get("next"),
  });

  if (!params.success) {
    logger.error("Invalid params for Vercel onboarding", { error: params.error });
    return redirectWithErrorMessage(
      "/",
      request,
      "Invalid installation parameters. Please try again from Vercel."
    );
  }

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

  if (organizations.length === 0) {
    const onboardingParams = new URLSearchParams({
      code: params.data.code,
      configurationId: params.data.configurationId,
      integration: "vercel",
    });
    if (params.data.next) {
      onboardingParams.set("next", params.data.next);
    }
    return redirect(`${confirmBasicDetailsPath()}?${onboardingParams.toString()}`);
  }

  // If organizationId is provided, show project selection
  if (params.data.organizationId) {
    const organization = organizations.find((org) => org.id === params.data.organizationId);

    if (!organization) {
      logger.error("Organization not found or access denied", {
        organizationId: params.data.organizationId,
        userId,
      });
      return redirectWithErrorMessage(
        "/",
        request,
        "Organization not found. Please try again."
      );
    }

    return json({
      step: "project" as const,
      organization,
      organizations,
      code: params.data.code,
      configurationId: params.data.configurationId,
      next: params.data.next,
    });
  }

  // Single org - automatically move to project selection
  if (organizations.length === 1) {
    const singleOrg = organizations[0];
    const projectParams = new URLSearchParams({
      organizationId: singleOrg.id,
      code: params.data.code,
      configurationId: params.data.configurationId,
    });
    if (params.data.next) {
      projectParams.set("next", params.data.next);
    }
    return redirect(`/onboarding/vercel?${projectParams.toString()}`);
  }

  // Multiple orgs - show org selection
  return json({
    step: "org" as const,
    organizations,
    code: params.data.code,
    configurationId: params.data.configurationId,
    next: params.data.next,
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

    const projectParams = new URLSearchParams({
      organizationId,
      code,
      configurationId,
    });
    if (next) {
      projectParams.set("next", next);
    }

    return redirect(`/onboarding/vercel?${projectParams.toString()}`);
  }

  // Handle project selection
  const { projectId, organizationId } = submission.data;

  // Install integration with selected project
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
    return redirectWithErrorMessage("/", request, "Project not found.");
  }

  const tokenResponse = await exchangeCodeForToken(code);
  if (!tokenResponse) {
    return redirectWithErrorMessage(
      "/",
      request,
      "Failed to connect to Vercel. Your session may have expired. Please try again from Vercel."
    );
  }

  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      projectId: project.id,
      slug: "prod",
      archivedAt: null,
    },
  });

  if (!environment) {
    return redirectWithErrorMessage(
      "/",
      request,
      "Failed to find project environment. Please try again."
    );
  }

  try {
    let orgIntegration = await VercelIntegrationRepository.findVercelOrgIntegrationByTeamId(
      project.organizationId,
      tokenResponse.teamId ?? null
    );

    if (orgIntegration) {
      await VercelIntegrationRepository.updateVercelOrgIntegrationToken({
        integrationId: orgIntegration.id,
        accessToken: tokenResponse.accessToken,
        tokenType: tokenResponse.tokenType,
        teamId: tokenResponse.teamId ?? null,
        userId: tokenResponse.userId,
        installationId: configurationId,
        raw: tokenResponse.raw,
      });

      orgIntegration = await VercelIntegrationRepository.findVercelOrgIntegrationByTeamId(
        project.organizationId,
        tokenResponse.teamId ?? null
      );
    } else {
      await VercelIntegrationRepository.createVercelOrgIntegration({
        accessToken: tokenResponse.accessToken,
        tokenType: tokenResponse.tokenType,
        teamId: tokenResponse.teamId ?? null,
        userId: tokenResponse.userId,
        installationId: configurationId,
        organization: project.organization,
        raw: tokenResponse.raw,
      });

      orgIntegration = await VercelIntegrationRepository.findVercelOrgIntegrationByTeamId(
        project.organizationId,
        tokenResponse.teamId ?? null
      );
    }

    if (!orgIntegration) {
      throw new Error("Failed to create or find Vercel organization integration");
    }

    logger.info("Vercel organization integration created successfully", {
      organizationId: project.organizationId,
      projectId: project.id,
      teamId: tokenResponse.teamId,
    });

    const settingsPath = v3ProjectSettingsPath(
      { slug: project.organization.slug },
      { slug: project.slug },
      { slug: environment.slug }
    );

    const params = new URLSearchParams({ vercelOnboarding: "true", fromMarketplace: "true" });
    if (next) {
      params.set("next", next);
    }

    return redirect(`${settingsPath}?${params.toString()}`);
  } catch (error) {
    logger.error("Failed to create Vercel integration", { error });
    return redirectWithErrorMessage(
      "/",
      request,
      "Failed to create Vercel integration. Please try again."
    );
  }
}

export default function VercelOnboardingPage() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  if (data.step === "org") {
    return (
      <AppContainer className="bg-charcoal-900">
        <BackgroundWrapper>
          <MainCenteredContainer className="max-w-[26rem] rounded-lg border border-grid-bright bg-background-dimmed p-5 shadow-lg">
            <FormTitle
              title="Select Organization"
              description="Choose which organization to install the Vercel integration into."
            />
            <Form method="post">
              <input type="hidden" name="action" value="select-org" />
              <input type="hidden" name="code" value={data.code} />
              <input type="hidden" name="configurationId" value={data.configurationId} />
              {data.next && <input type="hidden" name="next" value={data.next} />}

              <Fieldset>
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
                <div className="mt-2 flex w-full justify-between gap-2">
                  <Button variant="tertiary/medium" onClick={() => window.close()} className="w-full">
                    Cancel
                  </Button>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary/medium"
                      className="flex-1"
                      onClick={() => {
                        const params = new URLSearchParams({
                          code: data.code,
                          configurationId: data.configurationId,
                          integration: "vercel",
                        });
                        if (data.next) {
                          params.set("next", data.next);
                        }
                        window.location.href = `/orgs/new?${params.toString()}`;
                      }}
                    >
                      + New Organization
                    </Button>
                    <Button type="submit" variant="primary/medium" className="flex-1">
                      Continue
                    </Button>
                  </div>
                    
                </div>
              </Fieldset>
            </Form>
          </MainCenteredContainer>
        </BackgroundWrapper>
      </AppContainer>
    );
  }

  // Project selection step
  return (
    <AppContainer className="bg-charcoal-900">
      <BackgroundWrapper>
        <MainCenteredContainer className="max-w-[26rem] rounded-lg border border-grid-bright bg-background-dimmed p-5 shadow-lg">
          <FormTitle
            title="Select Project"
            description={`Choose which project in ${data.organization.title} to install the Vercel integration into.`}
          />
          <Form method="post">
            <input type="hidden" name="action" value="select-project" />
            <input type="hidden" name="organizationId" value={data.organization.id} />
            <input type="hidden" name="code" value={data.code} />
            <input type="hidden" name="configurationId" value={data.configurationId} />
            {data.next && <input type="hidden" name="next" value={data.next} />}

            <Fieldset>
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

              <div className="mt-2 flex w-full justify-between gap-2">
                <Button variant="tertiary/medium" onClick={() => window.close()} disabled={isSubmitting}>
                  Cancel
                </Button>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary/medium"
                    className="flex-1"
                    disabled={isSubmitting}
                    onClick={() => {
                      const params = new URLSearchParams({
                        code: data.code,
                        configurationId: data.configurationId,
                        integration: "vercel",
                        organizationId: data.organization.id,
                      });
                      if (data.next) {
                        params.set("next", data.next);
                      }
                      window.location.href = `${newProjectPath({ slug: data.organization.slug })}?${params.toString()}`;
                    }}
                  >
                    + New Project
                  </Button>
                  <Button type="submit" variant="primary/medium" disabled={isSubmitting} className="flex-1">
                    {isSubmitting ? "Installing..." : "Install Integration"}
                  </Button>
                </div>
              </div>
            </Fieldset>
          </Form>
        </MainCenteredContainer>
      </BackgroundWrapper>
    </AppContainer>
  );
}
