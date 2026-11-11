import { GITHUB_ACTIONS_ISSUER, TrustedDeployPolicy } from "@trigger.dev/core/v3";
import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import { z } from "zod";

export const GithubDeployClaims = z
  .object({
    iss: z.literal(GITHUB_ACTIONS_ISSUER),
    sub: z.string().min(1),
    repository: z.string().min(1),
    repository_id: z.string().regex(/^\d+$/),
    repository_owner: z.string().min(1),
    repository_owner_id: z.string().regex(/^\d+$/),
    ref: z.string().min(1),
    sha: z.string().regex(/^[a-f0-9]{40,64}$/),
    event_name: z.string().min(1),
    run_id: z.string().regex(/^\d+$/),
    run_attempt: z.string().regex(/^\d+$/),
    workflow_ref: z.string().min(1),
    job_workflow_ref: z.string().optional(),
    environment: z.string().optional(),
  })
  .passthrough();

export type GithubDeployClaims = z.infer<typeof GithubDeployClaims>;

type RepositoryPolicy = {
  issuer: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryId: string | null;
  repositoryOwnerId: string | null;
};

type EnvironmentPolicy = {
  enabled: boolean;
  scope: unknown;
  scopeValue: unknown;
  additionalClaims: unknown;
  environmentType: RuntimeEnvironmentType;
};

export function matchesTrustedDeploy(
  repository: RepositoryPolicy,
  grant: EnvironmentPolicy,
  claims: GithubDeployClaims
): boolean {
  if (!grant.enabled || grant.environmentType === "DEVELOPMENT" || repository.issuer !== claims.iss)
    return false;

  const [owner, name] = claims.repository.split("/");
  if (
    repository.repositoryId
      ? claims.repository_id !== repository.repositoryId
      : name?.toLowerCase() !== repository.repositoryName.toLowerCase()
  )
    return false;
  if (
    repository.repositoryOwnerId
      ? claims.repository_owner_id !== repository.repositoryOwnerId
      : owner?.toLowerCase() !== repository.repositoryOwner.toLowerCase()
  )
    return false;

  const parsed = TrustedDeployPolicy.safeParse(grant);
  if (!parsed.success) return false;
  const policy = parsed.data;
  if (
    claims.event_name.startsWith("pull_request") &&
    (grant.environmentType !== "PREVIEW" || claims.event_name !== "pull_request")
  )
    return false;

  const scopeMatches =
    policy.scope === "ANY" ||
    (policy.scope === "ENVIRONMENT"
      ? claims.environment === policy.scopeValue
      : matchesRef(
          `refs/${policy.scope === "BRANCH" ? "heads" : "tags"}/${policy.scopeValue}`,
          claims.ref
        ));

  return (
    scopeMatches &&
    Object.entries(policy.additionalClaims).every(([name, accepted]) => {
      const actual = claims[name];
      const values = Array.isArray(actual) ? actual : [actual];
      return values.some((value) => typeof value === "string" && accepted.includes(value));
    })
  );
}

function matchesRef(pattern: string, ref: string): boolean {
  // Tenant-controlled wildcards must not become a backtracking regular expression.
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === ref;

  const prefix = parts[0];
  const suffix = parts[parts.length - 1];
  if (!ref.startsWith(prefix) || !ref.endsWith(suffix)) return false;

  let cursor = prefix.length;
  const suffixStart = ref.length - suffix.length;
  if (cursor > suffixStart) return false;

  for (const part of parts.slice(1, -1)) {
    const index = ref.indexOf(part, cursor);
    if (index === -1 || index + part.length > suffixStart) return false;
    cursor = index + part.length;
  }
  return true;
}
