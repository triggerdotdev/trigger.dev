import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { fromPromise } from "neverthrow";
import { z } from "zod";
import { prisma } from "~/db.server";
import { VercelIntegrationRepository, type TokenResponse } from "~/models/vercelIntegration.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { requestUrl } from "~/utils/requestUrl.server";
import { v3ProjectSettingsPath } from "~/utils/pathBuilder";
import { validateVercelOAuthState } from "~/v3/vercel/vercelOAuthState.server";

const VercelConnectSchema = z.object({
  state: z.string(),
  configurationId: z.string().optional(),
  code: z.string(),
  next: z.string().optional(),
  origin: z.enum(["marketplace", "dashboard"]),
});

async function createOrFindVercelIntegration(
  organizationId: string,
  projectId: string,
  tokenResponse: TokenResponse,
  configurationId: string | undefined,
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

  const tokenResult = await VercelIntegrationRepository.exchangeCodeForToken(code);
  if (tokenResult.isErr()) {
    const params = new URLSearchParams({ error: "expired" });
    return redirect(`/vercel/onboarding?${params.toString()}`);
  }
  const tokenResponse = tokenResult.value;

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

  const settingsPath = v3ProjectSettingsPath(
    { slug: stateData.organizationSlug },
    { slug: stateData.projectSlug },
    { slug: environment.slug }
  );

  const result = await fromPromise(
    createOrFindVercelIntegration(stateData.organizationId, stateData.projectId, tokenResponse, configurationId, origin),
    (error) => error
  );

  if (result.isErr()) {
    logger.error("Failed to complete Vercel integration", { error: result.error });
    throw redirect(settingsPath);
  }

  logger.info("Vercel organization integration created successfully", {
    organizationId: stateData.organizationId,
    projectId: stateData.projectId,
    teamId: tokenResponse.teamId,
  });

  const params = new URLSearchParams({ vercelOnboarding: "true", origin });
  if (next) {
    params.set("next", next);
  }

  return redirect(`${settingsPath}?${params.toString()}`);
}
