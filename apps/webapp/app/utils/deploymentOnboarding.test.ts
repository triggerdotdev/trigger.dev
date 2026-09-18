import { expect, it } from "vitest";
import { shouldSelectDeploymentOnboarding } from "./deploymentOnboarding";

it("requires activation and preserves development, history, version and inspector navigation", () => {
  const defaults = {
    enabled: true,
    platformConfigured: true,
    environmentType: "PRODUCTION",
    url: new URL("https://example.test/deployments"),
  };
  expect(shouldSelectDeploymentOnboarding(defaults)).toBe(true);
  for (const override of [
    { enabled: false },
    { platformConfigured: false },
    { environmentType: "DEVELOPMENT" },
    { deploymentParam: "dp_explicit" },
    ...["?view=history", "?page=1", "?version=20260915.1"].map((query) => ({
      url: new URL(`https://example.test/deployments${query}`),
    })),
  ])
    expect(shouldSelectDeploymentOnboarding({ ...defaults, ...override })).toBe(false);
  for (const environmentType of ["STAGING", "PREVIEW"])
    expect(shouldSelectDeploymentOnboarding({ ...defaults, environmentType })).toBe(true);
});

it("allows an explicit local UI preview without relaxing the flag or environment guard", () => {
  const local = {
    enabled: true,
    platformConfigured: false,
    allowUnconfiguredPlatform: true,
    environmentType: "PRODUCTION",
    url: new URL("http://localhost/deployments"),
  };
  expect(shouldSelectDeploymentOnboarding(local)).toBe(true);
  expect(shouldSelectDeploymentOnboarding({ ...local, enabled: false })).toBe(false);
  expect(shouldSelectDeploymentOnboarding({ ...local, environmentType: "DEVELOPMENT" })).toBe(
    false
  );
  expect(shouldSelectDeploymentOnboarding({ ...local, allowUnconfiguredPlatform: false })).toBe(
    false
  );
});
