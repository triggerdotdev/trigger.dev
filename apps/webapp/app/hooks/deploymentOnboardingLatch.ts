import type { WorkerDeploymentStatus } from "@trigger.dev/database";

type OnboardingState = {
  showGitHubOnboarding: boolean;
  onboardingDetails?: { deployment: { shortCode: string; status: WorkerDeploymentStatus } };
};

export type OnboardingLatch<T> = { value: T; location: string } | undefined;

/**
 * Keeps a watched first build on screen after the loader stops selecting onboarding, until the
 * user navigates away (or reloads, which starts without a latch).
 */
export function resolveOnboardingLatch<T extends OnboardingState>(
  latch: OnboardingLatch<T>,
  current: T | undefined,
  location: string
): { latch: OnboardingLatch<T>; shown: T | undefined; latched: boolean } {
  if (current?.showGitHubOnboarding) {
    if (!current.onboardingDetails) return { latch: undefined, shown: current, latched: false };
    const next =
      latch?.value.onboardingDetails === current.onboardingDetails && latch.location === location
        ? latch
        : { value: current, location };
    return { latch: next, shown: current, latched: false };
  }

  if (latch && latch.location === location) {
    return { latch, shown: latch.value, latched: true };
  }

  return { latch: undefined, shown: current, latched: false };
}
