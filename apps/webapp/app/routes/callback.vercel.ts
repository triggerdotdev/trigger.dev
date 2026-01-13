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
import {
  v3ProjectSettingsPath,
  confirmBasicDetailsPath,
  newProjectPath,
} from "~/utils/pathBuilder";
import { validateVercelOAuthState } from "~/v3/vercel/vercelOAuthState.server";

// ============================================================================
// Types
// ============================================================================

type TokenResponse = {
  accessToken: string;
  tokenType: string;
  teamId?: string;
  userId?: string;
  raw: Record<string, unknown>;
};

type ProjectWithOrganization = {
  id: string;
  organizationId: string;
  organization: { id: string };
};

type StateData = {
  organizationId: string;
  projectId: string;
  environmentSlug: string;
  organizationSlug: string;
  projectSlug: string;
};

type CallbackParams = {
  code: string;
  state?: string;
  configurationId?: string;
  nextUrl?: string;
};

// ============================================================================
// Schema
// ============================================================================

const VercelCallbackSchema = z
  .object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
    configurationId: z.string().optional(),
    teamId: z.string().nullable().optional(),
    next: z.string().optional(),
    organizationId: z.string().optional(),
    projectId: z.string().optional(),
  })
  .passthrough();

// ============================================================================
// Shared Utilities
// ============================================================================

async function exchangeCodeForToken(code: string): Promise<TokenResponse | null> {
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
      raw: data as Record<string, unknown>,
    };
  } catch (error) {
    logger.error("Error exchanging Vercel OAuth code", { error });
    return null;
  }
}

async function createOrFindVercelIntegration(params: {
  tokenResponse: TokenResponse;
  project: ProjectWithOrganization;
  configurationId?: string;
}) {
  const { tokenResponse, project, configurationId } = params;

  let orgIntegration = await VercelIntegrationRepository.findVercelOrgIntegrationByTeamId(
    project.organizationId,
    tokenResponse.teamId ?? null
  );

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

  return orgIntegration;
}

async function fetchProjectWithAccess(
  projectId: string,
  organizationId: string,
  userId: string
): Promise<ProjectWithOrganization | null> {
  return prisma.project.findFirst({
    where: {
      id: projectId,
      organizationId,
      deletedAt: null,
      organization: {
        members: {
          some: {
            userId,
          },
        },
      },
    },
    include: {
      organization: true,
    },
  });
}

function buildSettingsRedirectUrl(stateData: StateData, nextUrl?: string): string {
  const settingsPath = v3ProjectSettingsPath(
    { slug: stateData.organizationSlug },
    { slug: stateData.projectSlug },
    { slug: stateData.environmentSlug }
  );

  const params = new URLSearchParams({ vercelOnboarding: "true" });
  if (nextUrl) {
    params.set("next", nextUrl);
  }

  return `${settingsPath}?${params.toString()}`;
}

async function completeIntegrationSetup(params: {
  tokenResponse: TokenResponse;
  project: ProjectWithOrganization;
  stateData: StateData;
  configurationId?: string;
  nextUrl?: string;
  request: Request;
  logContext: string;
}): Promise<Response> {
  const { tokenResponse, project, stateData, configurationId, nextUrl, request, logContext } =
    params;

  try {
    await createOrFindVercelIntegration({
      tokenResponse,
      project,
      configurationId,
    });

    logger.info(`Vercel organization integration created successfully ${logContext}`, {
      organizationId: project.organizationId,
      projectId: project.id,
      teamId: tokenResponse.teamId,
    });

    return redirect(buildSettingsRedirectUrl(stateData, nextUrl));
  } catch (error) {
    logger.error(`Failed to create Vercel integration ${logContext}`, { error });
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

// ============================================================================
// Marketplace-Invoked Flow (without state)
// User installs from Vercel marketplace, no state parameter present
// ============================================================================

async function handleMarketplaceInvokedFlow(params: {
  code: string;
  configurationId: string;
  nextUrl?: string;
  userId: string;
  request: Request;
}): Promise<Response> {
  const { code, configurationId, nextUrl, userId, request } = params;

  const userOrganizations = await prisma.organization.findMany({
    where: {
      members: {
        some: {
          userId,
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

  // No organizations - redirect to onboarding
  if (userOrganizations.length === 0) {
    const onboardingParams = new URLSearchParams({
      code,
      configurationId,
      integration: "vercel",
      fromMarketplace: "true",
    });
    if (nextUrl) {
      onboardingParams.set("next", nextUrl);
    }
    return redirect(`${confirmBasicDetailsPath()}?${onboardingParams.toString()}`);
  }

// Check if user has organizations with projects
  const hasProjects = userOrganizations.some((org) => org.projects.length > 0);
  if (!hasProjects) {
    const firstOrg = userOrganizations[0];
    const projectParams = new URLSearchParams({
      code,
      configurationId,
      integration: "vercel",
      fromMarketplace: "true",
    });
    if (nextUrl) {
      projectParams.set("next", nextUrl);
    }
    return redirect(`${newProjectPath({ slug: firstOrg.slug })}?${projectParams.toString()}`);
  }

  // Multiple organizations - redirect to onboarding
  if (userOrganizations.length > 1) {
    const selectionParams = new URLSearchParams({
      code,
      configurationId,
    });
    if (nextUrl) {
      selectionParams.set("next", nextUrl);
    }
    return redirect(`/onboarding/vercel?${selectionParams.toString()}`);
  }

  // Single organization - check project count
  const singleOrg = userOrganizations[0];

  if (singleOrg.projects.length > 1) {
    const projectParams = new URLSearchParams({
      organizationId: singleOrg.id,
      code,
      configurationId,
    });
    if (nextUrl) {
      projectParams.set("next", nextUrl);
    }
    return redirect(`/onboarding/vercel?${projectParams.toString()}`);
  }

  // Single org with single project - complete installation directly
  const tokenResponse = await exchangeCodeForToken(code);
  if (!tokenResponse) {
    return redirectWithErrorMessage(
      "/",
      request,
      "Failed to connect to Vercel. Your session may have expired. Please try again from Vercel."
    );
  }

  const singleProject = singleOrg.projects[0];

  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      projectId: singleProject.id,
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

  const stateData: StateData = {
    organizationId: singleOrg.id,
    projectId: singleProject.id,
    environmentSlug: environment.slug,
    organizationSlug: singleOrg.slug,
    projectSlug: singleProject.slug,
  };

  const project = await fetchProjectWithAccess(stateData.projectId, stateData.organizationId, userId);

  if (!project) {
    logger.error("Project not found or user does not have access", {
      projectId: stateData.projectId,
      userId,
    });
    throw new Response("Project not found", { status: 404 });
  }

  return completeIntegrationSetup({
    tokenResponse,
    project,
    stateData,
    configurationId,
    nextUrl,
    request,
    logContext: "after marketplace installation",
  });
}

// ============================================================================
// Self-Invoked Flow (with state)
// User clicks connect button from our app, state parameter contains project info
// ============================================================================

async function handleSelfInvokedFlow(params: {
  code: string;
  state: string;
  configurationId?: string;
  nextUrl?: string;
  userId: string;
  request: Request;
}): Promise<Response> {
  const { code, state, configurationId, nextUrl, userId, request } = params;

  const validationResult = await validateVercelOAuthState(state);

  if (!validationResult.ok) {
    logger.error("Invalid Vercel OAuth state JWT", {
      error: validationResult.error,
    });
    
      // Check if JWT has expired
      if (validationResult.error?.includes("expired") || validationResult.error?.includes("Token has expired")) {
        return redirectWithErrorMessage(
          "/",
          request,
          "Your installation session has expired. Please start the installation again."
        );
      }
    
      return redirectWithErrorMessage(
        "/",
        request,
        "Invalid installation session. Please try again."
      );
  }

  const stateData = validationResult.state;

  const project = await fetchProjectWithAccess(stateData.projectId, stateData.organizationId, userId);

  if (!project) {
    logger.error("Project not found or user does not have access", {
      projectId: stateData.projectId,
      userId,
    });
    throw new Response("Project not found", { status: 404 });
  }

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

  return completeIntegrationSetup({
    tokenResponse,
    project,
    stateData,
    configurationId,
    nextUrl,
    request,
    logContext: "via self-invoked flow",
  });
}

// ============================================================================
// Main Loader
// ============================================================================

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method.toUpperCase() !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Check authentication - redirect to login if not authenticated
  const userId = await getUserId(request);

  if (!userId) {
    const currentUrl = new URL(request.url);
    const redirectTo = `${currentUrl.pathname}${currentUrl.search}`;
    const referralCookie = await setReferralSourceCookie("vercel");

    const headers = new Headers();
    headers.append("Set-Cookie", referralCookie);

    throw redirect(`/login?redirectTo=${encodeURIComponent(redirectTo)}`, { headers });
  }

  const authenticatedUserId = await requireUserId(request);

  // Parse and validate callback parameters
  const url = requestUrl(request);
  const parsedParams = VercelCallbackSchema.safeParse(Object.fromEntries(url.searchParams));

  if (!parsedParams.success) {
    logger.error("Invalid Vercel callback params", { error: parsedParams.error });
    throw new Response("Invalid callback parameters", { status: 400 });
  }

  const {
    code,
    state,
    error,
    error_description,
    configurationId,
    next: nextUrl,
    organizationId,
    projectId,
  } = parsedParams.data;

  // Handle errors from Vercel
  if (error) {
    logger.error("Vercel OAuth error", { error, error_description });
    throw new Response("Vercel OAuth error", { status: 500 });
  }

  // Validate authorization code is present
  if (!code) {
    logger.error("Missing authorization code from Vercel callback");
    throw new Response("Missing authorization code", { status: 400 });
  }

  // Handle return from project creation with org and project IDs
  if (organizationId && projectId && configurationId && !state) {
    const project = await fetchProjectWithAccess(projectId, organizationId, authenticatedUserId);

    if (!project) {
      logger.error("Project not found or user does not have access", {
        projectId,
        organizationId,
        userId: authenticatedUserId,
      });
      return redirectWithErrorMessage(
        "/",
        request,
        "Project not found. Please try again."
      );
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

    const stateData: StateData = {
      organizationId: project.organizationId,
      projectId: project.id,
      environmentSlug: environment.slug,
      organizationSlug: project.organization.slug,
      projectSlug: project.slug,
    };

    return completeIntegrationSetup({
      tokenResponse,
      project,
      stateData,
      configurationId,
      nextUrl,
      request,
      logContext: "after project creation",
    });
  }

  // Route to appropriate handler based on presence of state parameter
  if (state) {
    // Self-invoked flow: user clicked connect from our app
    return handleSelfInvokedFlow({
      code,
      state,
      configurationId,
      nextUrl,
      userId: authenticatedUserId,
      request,
    });
  }

  // Marketplace-invoked flow: user installed from Vercel marketplace
  if (!configurationId) {
    logger.error("Missing both state and configurationId from Vercel callback");
    throw new Response("Missing state or configurationId parameter", { status: 400 });
  }

  return handleMarketplaceInvokedFlow({
    code,
    configurationId,
    nextUrl,
    userId: authenticatedUserId,
    request,
  });
}
