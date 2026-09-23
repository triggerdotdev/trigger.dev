import { useLocation } from "@remix-run/react";
import type { WorkerDeploymentStatus } from "@trigger.dev/database";
import { useState } from "react";
import { useTypedFetcher } from "remix-typedjson";
import type { loader as deploymentLoader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.deployments.$deploymentParam/route";
import { type OnboardingLatch, resolveOnboardingLatch } from "./deploymentOnboardingLatch";
import { useInterval } from "./useInterval";

type OnboardingState = {
  showGitHubOnboarding: boolean;
  onboardingDetails?: {
    deployment: {
      shortCode: string;
      status: WorkerDeploymentStatus;
      errorData?: { message?: string } | null;
    };
  };
};

const FINAL_STATUSES = new Set<WorkerDeploymentStatus>([
  "DEPLOYED",
  "FAILED",
  "CANCELED",
  "TIMED_OUT",
]);

export function useLatchedDeploymentOnboarding<T extends OnboardingState>(
  current: T | undefined,
  {
    deploymentPath,
    pollIntervalMs = 5000,
  }: { deploymentPath: (shortCode: string) => string; pollIntervalMs?: number }
): { onboarding: T | undefined; latched: boolean } {
  const location = useLocation();
  const [latch, setLatch] = useState<OnboardingLatch<T>>();
  const next = resolveOnboardingLatch(latch, current, location.pathname + location.search);
  if (next.latch !== latch) setLatch(next.latch);

  // The latched details are from the last poll before the swap, so fetch the build's final state.
  const fetcher = useTypedFetcher<typeof deploymentLoader>();
  const watched = next.latched ? next.shown?.onboardingDetails?.deployment : undefined;
  const fresh =
    watched && fetcher.data?.deployment.shortCode === watched.shortCode
      ? fetcher.data.deployment
      : undefined;
  const status = fresh?.status ?? watched?.status;
  useInterval({
    interval: pollIntervalMs,
    disabled: !watched || !status || FINAL_STATUSES.has(status),
    callback: () => {
      if (watched && fetcher.state === "idle") fetcher.load(deploymentPath(watched.shortCode));
    },
  });

  if (!next.shown?.onboardingDetails || !fresh) {
    return { onboarding: next.shown, latched: next.latched };
  }
  const onboarding = {
    ...next.shown,
    onboardingDetails: {
      ...next.shown.onboardingDetails,
      deployment: {
        ...next.shown.onboardingDetails.deployment,
        status: fresh.status,
        errorData: fresh.errorData,
      },
    },
  };
  return { onboarding, latched: next.latched };
}
