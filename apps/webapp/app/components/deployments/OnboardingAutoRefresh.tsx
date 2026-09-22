import { useAutoRevalidate } from "~/hooks/useAutoRevalidate";

// Mount only in the flag-enabled empty Tasks onboarding branch. Unmounting
// removes both the polling timer and the focus listeners.
export function OnboardingAutoRefresh({ interval }: { interval: number | undefined }) {
  useAutoRevalidate({ interval, onFocus: true });
  return null;
}
