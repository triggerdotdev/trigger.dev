import { type UIMatch } from "@remix-run/react";
import { useOptionalOrganization, type MatchedOrganization } from "./useOrganizations";

/**
 * Hook to access organization-level feature flags.
 * Returns the feature flags from the current organization, or an empty object if no organization is found.
 */
export function useFeatureFlags(matches?: UIMatch[]): Partial<MatchedOrganization["featureFlags"]> {
  const org = useOptionalOrganization(matches);
  return org?.featureFlags ?? {};
}
