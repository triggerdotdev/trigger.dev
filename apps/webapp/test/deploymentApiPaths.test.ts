import { describe, expect, it } from "vitest";
import { deploymentApiPaths } from "../app/services/deploymentApiPaths.server.js";

// Same matching semantics as authorizationRateLimitMiddleware's pathMatchers/pathWhiteList
function matchesAnyPath(path: string, matchers: (RegExp | string)[]): boolean {
  return matchers.some((matcher) =>
    matcher instanceof RegExp ? matcher.test(path) : path === matcher
  );
}

describe("deploymentApiPaths", () => {
  it("matches every endpoint the deploy flow calls", () => {
    const deployFlowPaths = [
      "/api/v1/deployments",
      "/api/v1/deployments/latest",
      "/api/v1/deployments/deployment_123",
      "/api/v1/deployments/deployment_123/progress",
      "/api/v1/deployments/deployment_123/fail",
      "/api/v1/deployments/deployment_123/cancel",
      "/api/v1/deployments/deployment_123/background-workers",
      "/api/v1/deployments/deployment_123/generate-registry-credentials",
      "/api/v1/deployments/20260811.1/promote",
      "/api/v3/deployments/deployment_123/finalize",
      "/api/v1/projects/proj_abc123/dev",
      "/api/v1/projects/proj_abc123/staging",
      "/api/v1/projects/proj_abc123/prod",
      "/api/v1/projects/proj_abc123/preview",
      "/api/v1/projects/proj_abc123/envvars",
      "/api/v1/projects/proj_abc123/envvars/prod/import",
      "/api/v1/projects/proj_abc123/branches",
      "/api/v1/projects/proj_abc123/branches/archive",
      "/api/v1/remote-build-provider-status",
      "/api/v1/artifacts",
    ];

    for (const path of deployFlowPaths) {
      expect(
        matchesAnyPath(path, deploymentApiPaths),
        `expected ${path} to be a deployment API path`
      ).toBe(true);
    }
  });

  it("does not match runtime API surface", () => {
    const runtimePaths = [
      "/api/v1/deployments/current",
      "/api/v1/deploymentsfoo",
      "/api/v1/whoami",
      "/api/v2/whoami",
      "/api/v1/tasks/my-task/trigger",
      "/api/v1/tasks/batch",
      "/api/v2/runs/run_123",
      "/api/v1/runs/run_123/replay",
      "/api/v3/runs/run_123/trace",
      "/api/v1/projects",
      "/api/v1/projects/proj_abc123",
      "/api/v1/projects/proj_abc123/dev-status",
      "/api/v1/projects/proj_abc123/prod/jwt",
      "/api/v1/projects/proj_abc123/envvars/prod",
      "/api/v1/projects/proj_abc123/envvars/prod/MY_VAR",
      "/api/v1/schedules",
      "/api/v1/queues/queue_123",
    ];

    for (const path of runtimePaths) {
      expect(
        matchesAnyPath(path, deploymentApiPaths),
        `expected ${path} not to be a deployment API path`
      ).toBe(false);
    }
  });
});
