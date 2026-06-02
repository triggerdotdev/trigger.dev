import { auth } from "@trigger.dev/sdk";
import { env } from "~/env.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { findProjectBySlug } from "~/models/project.server";

// The assistant runs as a Trigger.dev task on this same platform. Rather than
// stashing a secret, we authenticate SDK calls with the apiKey of the
// environment the user is currently viewing, read from the DB and scoped via
// `auth.withAuth`. Moving the assistant to a dedicated project would only
// change `resolveAssistantApiKey`.

export type AssistantEnvContext = {
  userId: string;
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
};

class AssistantAuthError extends Error {}

async function resolveAssistantApiKey(ctx: AssistantEnvContext): Promise<string> {
  const project = await findProjectBySlug(ctx.organizationSlug, ctx.projectSlug, ctx.userId);
  if (!project) {
    throw new AssistantAuthError(
      `AI assistant: no project "${ctx.projectSlug}" in org "${ctx.organizationSlug}" for this user`
    );
  }

  const environment = await findEnvironmentBySlug(project.id, ctx.environmentSlug, ctx.userId);
  if (!environment) {
    throw new AssistantAuthError(
      `AI assistant: no environment "${ctx.environmentSlug}" in project "${ctx.projectSlug}"`
    );
  }

  return environment.apiKey;
}

// Run `fn` with the SDK API client scoped to the current environment's key and
// this instance's own origin, so session/token calls hit the local platform.
export async function withAssistantAuth<T>(
  ctx: AssistantEnvContext,
  fn: () => Promise<T>
): Promise<T> {
  const apiKey = await resolveAssistantApiKey(ctx);

  return auth.withAuth(
    {
      baseURL: env.API_ORIGIN ?? env.APP_ORIGIN,
      accessToken: apiKey,
    },
    fn
  );
}
