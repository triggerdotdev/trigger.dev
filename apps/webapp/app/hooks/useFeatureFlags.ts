import { type UIMatch } from "@remix-run/react";
import { useOptionalOrganization } from "./useOrganizations";

/**
 * Hook to access organization-level feature flags.
 * Returns the feature flags from the current organization, or an empty object if no organization is found.
 */
export function useFeatureFlags(matches?: UIMatch[]) {
  const org = useOptionalOrganization(matches);
  return org?.featureFlags ?? {};
}
