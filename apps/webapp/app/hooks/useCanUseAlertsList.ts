import { computeCanUseAlertsList } from "~/v3/canUseAlertsList";
import { useFeatureFlags } from "./useFeatureFlags";
import { useFeatures } from "./useFeatures";
import { useOptionalUser } from "./useUser";

// Mirrors the server rule: only the user's own admin flag counts, not impersonation.
export function useCanUseAlertsList(): boolean {
  const { alertsConfigured } = useFeatures();
  const featureFlags = useFeatureFlags();
  const isAdmin = Boolean(useOptionalUser()?.admin);
  return computeCanUseAlertsList(featureFlags.alertsEnabled === true, isAdmin, alertsConfigured);
}
