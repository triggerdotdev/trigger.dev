import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { VercelIntegrationRepository } from "~/models/vercelIntegration.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { requestUrl } from "~/utils/requestUrl.server";
import { v3ProjectSettingsPath } from "~/utils/pathBuilder";
import { validateVercelOAuthState } from "~/v3/vercel/vercelOAuthState.server";

const VercelConnectSchema = z.object({
  state: z.string(),
  configurationId: z.string(),
  code: z.string(),
  next: z.string().optional(),
  origin: z.enum(["marketplace", "dashboard"]),
});

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
  const redirectUri = `${env.APP_ORIGIN}/vercel/callback`;

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

async function createOrFindVercelIntegration(
  organizationId: string,
  projectId: string,
  tokenResponse: TokenResponse,
  configurationId: string,
  origin: 'marketplace' | 'dashboard'
): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { organization: true },
  });

  if (!project) {
    throw new Error("Project not found");
  }

  let orgIntegration = await VercelIntegrationRepository.findVercelOrgIntegrationByTeamId(
    organizationId,
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
      raw: tokenResponse.raw
    });
  } else {
    await VercelIntegrationRepository.createVercelOrgIntegration({
      accessToken: tokenResponse.accessToken,
      tokenType: tokenResponse.tokenType,
      teamId: tokenResponse.teamId ?? null,
      userId: tokenResponse.userId,
      installationId: configurationId,
      organization: project.organization,
      raw: tokenResponse.raw,
      origin,
    });
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const url = requestUrl(request);

  const parsed = VercelConnectSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    logger.error("Invalid Vercel connect params", { error: parsed.error });
    throw new Response("Invalid parameters", { status: 400 });
  }

  const { state, configurationId, code, next, origin } = parsed.data;

  const validationResult = await validateVercelOAuthState(state);
  if (!validationResult.ok) {
    logger.error("Invalid Vercel OAuth state JWT", { error: validationResult.error });

    if (
      validationResult.error?.includes("expired") ||
      validationResult.error?.includes("Token has expired")
    ) {
      const params = new URLSearchParams({ error: "expired" });
      return redirect(`/vercel/onboarding?${params.toString()}`);
    }

    throw new Response("Invalid state", { status: 400 });
  }

  const stateData = validationResult.state;

  const project = await prisma.project.findFirst({
    where: {
      id: stateData.projectId,
      organizationId: stateData.organizationId,
      deletedAt: null,
      organization: {
        members: {
          some: { userId },
        },
      },
    },
    include: {
      organization: true,
    },
  });

  if (!project) {
    logger.error("Project not found or access denied", {
      projectId: stateData.projectId,
      userId,
    });
    throw new Response("Project not found", { status: 404 });
  }

  const tokenResponse = await exchangeCodeForToken(code);
  if (!tokenResponse) {
    const params = new URLSearchParams({ error: "expired" });
    return redirect(`/vercel/onboarding?${params.toString()}`);
  }

  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      projectId: project.id,
      slug: stateData.environmentSlug,
      archivedAt: null,
    },
  });

  if (!environment) {
    logger.error("Environment not found", {
      projectId: project.id,
      environmentSlug: stateData.environmentSlug,
    });
    throw new Response("Environment not found", { status: 404 });
  }

  try {
    await createOrFindVercelIntegration(stateData.organizationId, stateData.projectId, tokenResponse, configurationId, origin);

    logger.info("Vercel organization integration created successfully", {
      organizationId: stateData.organizationId,
      projectId: stateData.projectId,
      teamId: tokenResponse.teamId,
    });

    const settingsPath = v3ProjectSettingsPath(
      { slug: stateData.organizationSlug },
      { slug: stateData.projectSlug },
      { slug: environment.slug }
    );

    const params = new URLSearchParams({ vercelOnboarding: "true", origin });
    if (next) {
      params.set("next", next);
    }

    return redirect(`${settingsPath}?${params.toString()}`);
  } catch (error) {
    logger.error("Failed to complete Vercel integration", { error });

    const settingsPath = v3ProjectSettingsPath(
      { slug: stateData.organizationSlug },
      { slug: stateData.projectSlug },
      { slug: environment.slug }
    );

    throw redirect(settingsPath);
  }
}
