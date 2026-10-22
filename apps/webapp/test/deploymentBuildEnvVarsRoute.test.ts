import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DbServer from "~/db.server";

const mocks = vi.hoisted(() => ({
  authenticateApiKeyWithScope: vi.fn<(...args: any[]) => Promise<any>>(),
  findFirst: vi.fn<(...args: any[]) => Promise<any>>(),
}));

vi.mock("~/services/apiAuth.server", () => ({
  authenticateApiKeyWithScope: mocks.authenticateApiKeyWithScope,
}));
vi.mock("~/db.server", async (importOriginal) => ({
  ...(await importOriginal<typeof DbServer>()),
  prisma: { workerDeployment: { findFirst: mocks.findFirst } },
}));

import { env } from "~/env.server";
import { loader } from "~/routes/api.v1.deployments.$deploymentId.build-env-vars";
import { encryptSecret } from "~/services/secrets/secretStore.server";

const variables = { DATABASE_URL: "postgres://build", API_TOKEN: "secret" };

function load(deploymentId = "deployment_abc") {
  return loader({
    request: new Request(
      `https://app.example.com/api/v1/deployments/${deploymentId}/build-env-vars`
    ),
    params: { deploymentId },
    context: {},
  });
}

describe("deployment build env vars route", () => {
  beforeEach(async () => {
    mocks.authenticateApiKeyWithScope.mockReset().mockResolvedValue({
      ok: true,
      authentication: { environment: { id: "env_1", projectId: "proj_1" } },
    });
    mocks.findFirst.mockReset();
  });

  async function storedDeployment(status: string) {
    return {
      id: "dep_1",
      status,
      buildEnvVars: await encryptSecret(env.ENCRYPTION_KEY, JSON.stringify(variables)),
    };
  }

  it("serves the variables of an in-flight deployment", async () => {
    mocks.findFirst.mockResolvedValue(await storedDeployment("BUILDING"));

    const response = await load();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ variables });
    expect(mocks.authenticateApiKeyWithScope.mock.calls[0]![1]).toEqual({
      action: "write",
      resource: { type: "deployments" },
    });
  });

  it.each(["DEPLOYED", "FAILED", "CANCELED", "TIMED_OUT"])(
    "serves no variables for a %s deployment that still holds its envelope",
    async (status) => {
      mocks.findFirst.mockResolvedValue(await storedDeployment(status));

      const response = await load();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ variables: {} });
    }
  );
});
