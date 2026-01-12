import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { VercelIntegrationRepository } from "~/models/vercelIntegration.server";
import { logger } from "~/services/logger.server";
import { getUserId, requireUserId } from "~/services/session.server";
import { setReferralSourceCookie } from "~/services/referralSource.server";
import { requestUrl } from "~/utils/requestUrl.server";
import { v3ProjectSettingsPath, confirmBasicDetailsPath, newProjectPath } from "~/utils/pathBuilder";
import { validateVercelOAuthState } from "~/v3/vercel/vercelOAuthState.server";

async function createOrFindVercelIntegration(params: {
  tokenResponse: {
    accessToken: string;
    tokenType: string;
    teamId?: string;
    userId?: string;
    raw: Record<string, any>;
  };
  project: {
    organizationId: string;
    organization: { id: string; };
  };
  configurationId?: string;
}) {
  const { tokenResponse, project, configurationId } = params;
  
  // Check if we already have a Vercel org integration for this team
  let orgIntegration = await VercelIntegrationRepository.findVercelOrgIntegrationByTeamId(
    project.organizationId,
    tokenResponse.teamId ?? null
  );

  // If integration exists, update the token instead of creating new one
  if (orgIntegration) {
    logger.info("Updating existing Vercel integration token", {
      integrationId: orgIntegration.id,
      teamId: tokenResponse.teamId,
      organizationId: project.organizationId,
    });

    await VercelIntegrationRepository.updateVercelOrgIntegrationToken({
      integrationId: orgIntegration.id,
      accessToken: tokenResponse.accessToken,
      tokenType: tokenResponse.tokenType,
      teamId: tokenResponse.teamId ?? null,
      userId: tokenResponse.userId,
      installationId: configurationId,
      raw: tokenResponse.raw,
    });

    // Re-fetch to get updated integration
    orgIntegration = await VercelIntegrationRepository.findVercelOrgIntegrationByTeamId(
      project.organizationId,
      tokenResponse.teamId ?? null
    );
  } else {
    // Create new org integration if it doesn't exist
    await VercelIntegrationRepository.createVercelOrgIntegration({
      accessToken: tokenResponse.accessToken,
      tokenType: tokenResponse.tokenType,
      teamId: tokenResponse.teamId ?? null,
      userId: tokenResponse.userId,
      installationId: configurationId,
      organization: project.organization,
      raw: tokenResponse.raw,
    });

    // Re-fetch to get the full integration with tokenReference
    orgIntegration = await VercelIntegrationRepository.findVercelOrgIntegrationByTeamId(
      project.organizationId,
      tokenResponse.teamId ?? null
    );
  }

  if (!orgIntegration) {
    throw new Error("Failed to create or find Vercel organization integration");
  }

  return orgIntegration;
}

const VercelCallbackSchema = z
  .object({
    // OAuth authorization code
    code: z.string().optional(),
    // State parameter for CSRF protection (contains org/project info)
    state: z.string().optional(),
    // Error from Vercel
    error: z.string().optional(),
    error_description: z.string().optional(),
    // Vercel configuration ID
    configurationId: z.string().optional(),
    // Team ID if installed on a team (null for personal account)
    teamId: z.string().nullable().optional(),
    // The next URL Vercel wants us to redirect to (optional)
    next: z.string().optional(),
  })
  .passthrough();


// Vercel OAuth callback handler
// Flow: Connect button → Vercel marketplace → user authorizes → callback with code → exchange for token → create integration
export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method.toUpperCase() !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Check if user is authenticated
  const userId = await getUserId(request);
  
  // If not authenticated, set referral source cookie and redirect to login
  // Preserve all search params (code, configurationId, etc.) in the redirectTo
  if (!userId) {
    const currentUrl = new URL(request.url);
    // Preserve the full URL including all search params
    const redirectTo = `${currentUrl.pathname}${currentUrl.search}`;
    const referralCookie = await setReferralSourceCookie("vercel");
    
    const headers = new Headers();
    headers.append("Set-Cookie", referralCookie);
    
    throw redirect(`/login?redirectTo=${encodeURIComponent(redirectTo)}`, { headers });
  }

  // User is authenticated, proceed with OAuth callback
  const authenticatedUserId = await requireUserId(request);

  const url = requestUrl(request);
  const parsedParams = VercelCallbackSchema.safeParse(Object.fromEntries(url.searchParams));

  if (!parsedParams.success) {
    logger.error("Invalid Vercel callback params", { error: parsedParams.error });
    throw new Response("Invalid callback parameters", { status: 400 });
  }

  const { code, state, error, error_description, configurationId, next: nextUrl } = parsedParams.data;

  // Handle errors from Vercel
  if (error) {
    logger.error("Vercel OAuth error", { error, error_description });
    // Redirect to a generic error page or back to settings
    return redirect(`/?error=${encodeURIComponent(error_description || error)}`);
  }

  // Validate required parameters
  if (!code) {
    logger.error("Missing authorization code from Vercel callback");
    throw new Response("Missing authorization code", { status: 400 });
  }

  // Handle case when state is missing (Vercel-side installation)
  if (!state) {
    if (!configurationId) {
      logger.error("Missing both state and configurationId from Vercel callback");
      throw new Response("Missing state or configurationId parameter", { status: 400 });
    }

    // Check if user has organizations
    const userOrganizations = await prisma.organization.findMany({
      where: {
        members: {
          some: {
            userId: authenticatedUserId,
          },
        },
        deletedAt: null,
      },
      include: {
        projects: {
          where: {
            deletedAt: null,
          },
        },
      },
    });

    // If user has no organizations, redirect to onboarding
    if (userOrganizations.length === 0) {
      const params = new URLSearchParams({
        code,
        configurationId,
        integration: "vercel",
      });
      if (nextUrl && !state) {
        params.set("next", nextUrl);
      }
      const onboardingUrl = `${confirmBasicDetailsPath()}?${params.toString()}`;
      return redirect(onboardingUrl);
    }

    // If user has organizations but no projects, redirect to project creation
    const hasProjects = userOrganizations.some((org) => org.projects.length > 0);
    if (!hasProjects) {
      // Redirect to the first organization's project creation page
      const firstOrg = userOrganizations[0];
      const params = new URLSearchParams({
        code,
        configurationId,
        integration: "vercel",
      });
      if (nextUrl && !state) {
        params.set("next", nextUrl);
      }
      const projectUrl = `${newProjectPath({ slug: firstOrg.slug })}?${params.toString()}`;
      return redirect(projectUrl);
    }

    // User has orgs and projects - handle the installation after onboarding
    // Exchange code for access token first
    const tokenResponse = await exchangeCodeForToken(code);
    if (!tokenResponse) {
      return redirectWithErrorMessage(
        "/",
        request,
        "Failed to connect to Vercel. Please try again."
      );
    }

    // Fetch configuration from Vercel
    const config = await VercelIntegrationRepository.getVercelIntegrationConfiguration(
      tokenResponse.accessToken,
      configurationId,
      tokenResponse.teamId ?? null
    );

    if (!config) {
      return redirectWithErrorMessage(
        "/",
        request,
        "Failed to fetch Vercel integration configuration. Please try again."
      );
    }

    // Get user's first organization and project
    const userOrg = userOrganizations[0];
    const userProject = userOrg.projects[0];

    if (!userProject) {
      // This shouldn't happen since we checked above, but handle it anyway
      const projectUrl = `${newProjectPath({ slug: userOrg.slug })}?code=${encodeURIComponent(code)}&configurationId=${encodeURIComponent(configurationId)}&integration=vercel`;
      return redirect(projectUrl);
    }

    // Get the default environment (prod)
    const environment = await prisma.runtimeEnvironment.findFirst({
      where: {
        projectId: userProject.id,
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

    // Now proceed with the normal flow using the generated state
    // We'll use the stateData from the generated state
    const stateData = {
      organizationId: userOrg.id,
      projectId: userProject.id,
      environmentSlug: environment.slug,
      organizationSlug: userOrg.slug,
      projectSlug: userProject.slug,
    };

    const project = await prisma.project.findFirst({
      where: {
        id: stateData.projectId,
        organizationId: stateData.organizationId,
        deletedAt: null,
        organization: {
          members: {
            some: {
              userId: authenticatedUserId,
            },
          },
        },
      },
      include: {
        organization: true,
      },
    });

    if (!project) {
      logger.error("Project not found or user does not have access", {
        projectId: stateData.projectId,
        userId: authenticatedUserId,
      });
      throw new Response("Project not found", { status: 404 });
    }

    // Create the integration
    try {
      await createOrFindVercelIntegration({
        tokenResponse,
        project,
        configurationId,
      });

      logger.info("Vercel organization integration created successfully after onboarding", {
        organizationId: project.organizationId,
        projectId: project.id,
        teamId: tokenResponse.teamId,
      });

      // Redirect to settings page with onboarding query parameter
      const settingsPath = v3ProjectSettingsPath(
        { slug: stateData.organizationSlug },
        { slug: stateData.projectSlug },
        { slug: stateData.environmentSlug }
      );

      const params = new URLSearchParams({ vercelOnboarding: "true" });
      if (nextUrl && !state) {
        params.set("next", nextUrl);
      }
      return redirect(`${settingsPath}?${params.toString()}`);
    } catch (error) {
      logger.error("Failed to create Vercel integration after onboarding", { error });
      return redirectWithErrorMessage(
        "/",
        request,
        "Failed to create Vercel integration. Please try again."
      );
    }
  }

  // Validate and decode JWT state (existing flow)
  const validationResult = await validateVercelOAuthState(state!);

  if (!validationResult.ok) {
    logger.error("Invalid Vercel OAuth state JWT", {
      error: validationResult.error,
    });
    throw new Response("Invalid state parameter", { status: 400 });
  }

  const stateData = validationResult.state;

  // Verify user has access to the organization and project
  const project = await prisma.project.findFirst({
    where: {
      id: stateData.projectId,
      organizationId: stateData.organizationId,
      deletedAt: null,
      organization: {
        members: {
          some: {
            userId: authenticatedUserId,
          },
        },
      },
    },
    include: {
      organization: true,
    },
  });

  if (!project) {
    logger.error("Project not found or user does not have access", {
      projectId: stateData.projectId,
      userId: authenticatedUserId,
    });
    throw new Response("Project not found", { status: 404 });
  }

  // Exchange authorization code for access token
  const tokenResponse = await exchangeCodeForToken(code);
  if (!tokenResponse) {
    return redirectWithErrorMessage(
      v3ProjectSettingsPath(
        { slug: stateData.organizationSlug },
        { slug: stateData.projectSlug },
        { slug: stateData.environmentSlug }
      ),
      request,
      "Failed to connect to Vercel. Please try again."
    );
  }

  try {
    await createOrFindVercelIntegration({
      tokenResponse,
      project,
      configurationId,
    });

    // The OrganizationIntegration is now created.
    // The user will select a Vercel project during onboarding, which will create the
    // OrganizationProjectIntegration record and sync API keys to Vercel.

    logger.info("Vercel organization integration created successfully", {
      organizationId: project.organizationId,
      projectId: project.id,
      teamId: tokenResponse.teamId,
    });

      // Redirect to settings page with onboarding query parameter
      const settingsPath = v3ProjectSettingsPath(
        { slug: stateData.organizationSlug },
        { slug: stateData.projectSlug },
        { slug: stateData.environmentSlug }
      );

      const params = new URLSearchParams({ vercelOnboarding: "true" });
      if (nextUrl && !state) {
        params.set("next", nextUrl);
      }
      return redirect(`${settingsPath}?${params.toString()}`);
  } catch (error) {
    logger.error("Failed to create Vercel integration", { error });
    return redirectWithErrorMessage(
      v3ProjectSettingsPath(
        { slug: stateData.organizationSlug },
        { slug: stateData.projectSlug },
        { slug: stateData.environmentSlug }
      ),
      request,
      "Failed to create Vercel integration. Please try again."
    );
  }
}

async function exchangeCodeForToken(code: string): Promise<{
  accessToken: string;
  tokenType: string;
  teamId?: string;
  userId?: string;
  raw: Record<string, any>;
} | null> {
  const clientId = env.VERCEL_INTEGRATION_CLIENT_ID;
  const clientSecret = env.VERCEL_INTEGRATION_CLIENT_SECRET;
  const redirectUri = `${env.APP_ORIGIN}/callback/vercel`;

  if (!clientId || !clientSecret) {
    logger.error("Vercel integration not configured - missing client ID or secret");
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
      raw: data as Record<string, any>,
    };
  } catch (error) {
    logger.error("Error exchanging Vercel OAuth code", { error });
    return null;
  }
}
