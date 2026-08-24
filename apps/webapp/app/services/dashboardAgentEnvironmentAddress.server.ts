/**
 * How the dashboard agent addresses one environment on the name-addressed API routes.
 *
 * The name is derived from the environment's type, and every branch shares its parent's type — so
 * the name alone does not identify an environment, it identifies a family. The branch is the rest
 * of the address, and the API's resolver needs both to land on the row the dashboard selected.
 *
 * Returned as a pair so no caller can take the name without it. Handing the JWT exchange a bare
 * "preview" resolves the parent, and the delegated token's `environmentId` claim then correctly
 * refuses it — the guard is the detector, not the defect.
 *
 * Kept free of heavy imports so both mint sites and their tests can use the real thing.
 */

// The API's env routes key on the canonical env name, not the dashboard URL slug
// (staging's slug is "stg").
const ENV_NAME_BY_TYPE: Record<string, string> = {
  DEVELOPMENT: "dev",
  STAGING: "staging",
  PRODUCTION: "prod",
  PREVIEW: "preview",
};

export type DashboardAgentEnvironmentAddress = {
  environmentName?: string;
  environmentBranch?: string;
};

export function dashboardAgentEnvironmentAddress(
  environment: { type: string; branchName?: string | null } | undefined
): DashboardAgentEnvironmentAddress {
  if (!environment) return {};
  return {
    environmentName: ENV_NAME_BY_TYPE[environment.type],
    ...(environment.branchName ? { environmentBranch: environment.branchName } : {}),
  };
}
