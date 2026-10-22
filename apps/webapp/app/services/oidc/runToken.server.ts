import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import { env } from "~/env.server";
import { FEATURE_FLAG, FeatureFlagCatalog } from "~/v3/featureFlags";
import { globalFlagsRegistry } from "~/v3/globalFlagsRegistry.server";
import { internalRunSigningService } from "./instance.server";
import {
  RUN_TOKEN_AUDIENCE,
  RUN_TOKEN_TTL_SECONDS,
  RUN_TOKEN_TYPE,
  RUN_TOKEN_USE,
  runTokenScopes,
} from "./runTokenClaims";

export type RunTokenIdentity = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  environmentType: RuntimeEnvironmentType;
  runFriendlyId: string;
  attemptNumber: number;
  taskIdentifier: string;
  deploymentFriendlyId?: string;
};

export function mintRunToken(identity: RunTokenIdentity): Promise<string> {
  return internalRunSigningService.signJwt(
    {
      token_use: RUN_TOKEN_USE,
      org_id: identity.organizationId,
      project_id: identity.projectId,
      environment_id: identity.environmentId,
      environment_type: identity.environmentType,
      run_id: identity.runFriendlyId,
      attempt: identity.attemptNumber,
      task_id: identity.taskIdentifier,
      ...(identity.deploymentFriendlyId ? { deployment_id: identity.deploymentFriendlyId } : {}),
      scopes: runTokenScopes(identity.runFriendlyId),
    },
    {
      audience: RUN_TOKEN_AUDIENCE,
      subject: `run:${identity.runFriendlyId}`,
      expiresInSeconds: RUN_TOKEN_TTL_SECONDS,
      typ: RUN_TOKEN_TYPE,
    }
  );
}

/** Org override wins in both directions; otherwise the global flag; otherwise off. */
export function runTokenInjectionEnabled(orgFeatureFlags: unknown): boolean {
  if (!env.RUN_TOKEN_ISSUER_URL) return false;

  const flag = FeatureFlagCatalog[FEATURE_FLAG.runTokenInjection];

  if (orgFeatureFlags && typeof orgFeatureFlags === "object" && !Array.isArray(orgFeatureFlags)) {
    const override = flag.safeParse(
      (orgFeatureFlags as Record<string, unknown>)[FEATURE_FLAG.runTokenInjection]
    );
    if (override.success) return override.data;
  }

  return globalFlagsRegistry.current()?.[FEATURE_FLAG.runTokenInjection] ?? false;
}
