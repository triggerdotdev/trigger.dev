import { expect, it } from "vitest";
import { resolveOnboardingLatch } from "./deploymentOnboardingLatch";

const building = {
  showGitHubOnboarding: true,
  onboardingDetails: { deployment: { shortCode: "abc", status: "BUILDING" as const } },
};
const idle = { showGitHubOnboarding: true, onboardingDetails: undefined };
const done = { showGitHubOnboarding: false, onboardingDetails: undefined };
const here = "/orgs/o/projects/p/env/prod/deployments";

it("keeps showing the watched build after the loader stops selecting onboarding", () => {
  const watching = resolveOnboardingLatch(undefined, building, here);
  expect(watching).toMatchObject({ shown: building, latched: false });

  const completed = resolveOnboardingLatch(watching.latch, done, here);
  expect(completed).toMatchObject({ shown: building, latched: true });

  // Later polls keep it on screen too.
  expect(resolveOnboardingLatch(completed.latch, done, here).shown).toBe(building);
});

it("keeps showing it when the loader drops onboarding entirely (tasks appeared)", () => {
  const { latch } = resolveOnboardingLatch(undefined, building, here);
  expect(resolveOnboardingLatch(latch, undefined, here)).toMatchObject({
    shown: building,
    latched: true,
  });
});

it("lets the normal page through after navigating", () => {
  const { latch } = resolveOnboardingLatch(undefined, building, here);
  expect(resolveOnboardingLatch(latch, done, `${here}/abc`)).toEqual({
    latch: undefined,
    shown: done,
    latched: false,
  });
});

it("doesn't latch before a build has started", () => {
  const { latch } = resolveOnboardingLatch(undefined, idle, here);
  expect(latch).toBeUndefined();
  expect(resolveOnboardingLatch(latch, done, here).shown).toBe(done);
});

it("keeps the same latch while the loader data is unchanged", () => {
  const first = resolveOnboardingLatch(undefined, building, here);
  expect(resolveOnboardingLatch(first.latch, building, here).latch).toBe(first.latch);
});

it("keeps the same latch when a caller rebuilds the wrapper object each render", () => {
  const first = resolveOnboardingLatch(undefined, { ...building }, here);
  expect(resolveOnboardingLatch(first.latch, { ...building }, here).latch).toBe(first.latch);
});
