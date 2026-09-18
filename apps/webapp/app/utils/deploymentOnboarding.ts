/** Explicit history and inspector navigation always take precedence over onboarding. */
export function shouldSelectDeploymentOnboarding({
  enabled,
  platformConfigured,
  allowUnconfiguredPlatform = false,
  environmentType,
  url,
  deploymentParam,
}: {
  enabled: boolean;
  platformConfigured: boolean;
  allowUnconfiguredPlatform?: boolean;
  environmentType: string;
  url: URL;
  deploymentParam?: string;
}) {
  return (
    enabled &&
    (platformConfigured || allowUnconfiguredPlatform) &&
    environmentType !== "DEVELOPMENT" &&
    !deploymentParam &&
    url.searchParams.get("view") !== "history" &&
    !url.searchParams.has("page") &&
    !url.searchParams.has("version")
  );
}
