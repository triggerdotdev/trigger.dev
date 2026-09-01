import { describe, expect, it } from "vitest";
import { buildDeploymentS2Client, deploymentS2ClientOptions } from "./s2ClientConfig";

const BASIN = "trigger-local";

describe("buildDeploymentS2Client", () => {
  // The SDK resolves an endpoints key with undefined members to the same hosted URLs, so nothing
  // on the built client distinguishes the two calls. Assert on the options instead.
  it("hands the SDK no endpoints key at all when no endpoint is configured", () => {
    expect(deploymentS2ClientOptions({ accessToken: "token" })).toEqual({ accessToken: "token" });
    expect(deploymentS2ClientOptions({ accessToken: "token" })).not.toHaveProperty("endpoints");
  });

  it("hands the SDK one endpoint for both hosts when configured", () => {
    expect(
      deploymentS2ClientOptions({ accessToken: "token", endpoint: "http://localhost:4566" })
    ).toEqual({
      accessToken: "token",
      endpoints: { account: "http://localhost:4566", basin: "http://localhost:4566" },
    });
  });

  it("still resolves the SDK's hosted defaults when no endpoint is configured", () => {
    const client = buildDeploymentS2Client({ accessToken: "token" });

    expect(client.endpoints.accountBaseUrl()).toBe("https://a.s2.dev/v1");
    expect(client.endpoints.basinBaseUrl(BASIN)).toBe(`https://${BASIN}.b.s2.dev/v1`);
    expect(client.endpoints.includeBasinHeader).toBe(false);
  });

  it("points both the account and basin hosts at a configured endpoint", () => {
    const client = buildDeploymentS2Client({
      accessToken: "token",
      endpoint: "http://localhost:4566",
    });

    expect(client.endpoints.accountBaseUrl()).toBe("http://localhost:4566/v1");
    expect(client.endpoints.basinBaseUrl(BASIN)).toBe("http://localhost:4566/v1");
    expect(client.endpoints.includeBasinHeader).toBe(true);
  });

  // A split configuration would send the access token to the hosted service while the operator
  // believed the client was entirely local, so one value has to drive both hosts.
  it("never leaves one host hosted while the other is overridden", () => {
    const client = buildDeploymentS2Client({
      accessToken: "token",
      endpoint: "http://localhost:4566",
    });

    expect(client.endpoints.accountBaseUrl()).not.toContain("s2.dev");
    expect(client.endpoints.basinBaseUrl(BASIN)).not.toContain("s2.dev");
  });
});
