import { describe, expect, it } from "vitest";
import {
  cliCanFollow,
  type DeploymentLogsConfig,
  publicEndpoint,
  skipsAccessTokens,
} from "~/v3/deploymentLogsConfig";

const hosted: DeploymentLogsConfig = {
  S2_ENABLED: "1",
  S2_DEPLOYMENT_LOGS_SKIP_ACCESS_TOKENS: "0",
};

describe("deployment build logs config", () => {
  it("lets the CLI follow build logs on hosted S2 with access tokens", () => {
    expect(cliCanFollow(hosted)).toBe(true);
  });

  // Catches: the deploy API handing the CLI a stream it then fails to read from s2.dev.
  it("doesn't let the CLI follow build logs on a self-hosted S2", () => {
    const config = { ...hosted, S2_DEPLOYMENT_LOGS_ENDPOINT: "http://localhost:4566/v1" };
    expect(publicEndpoint(config)).toBe("http://localhost:4566/v1");
    expect(cliCanFollow(config)).toBe(false);
  });

  it("reads from the public endpoint when one is set", () => {
    const config = {
      ...hosted,
      S2_DEPLOYMENT_LOGS_ENDPOINT: "http://s2/v1",
      S2_DEPLOYMENT_LOGS_PUBLIC_ENDPOINT: "https://s2.example.com/v1",
    };
    expect(publicEndpoint(config)).toBe("https://s2.example.com/v1");
    expect(cliCanFollow(config)).toBe(false);
  });

  // Catches: the CLI being given the placeholder token and failing its log follow.
  it("doesn't let the CLI follow build logs when access tokens are skipped", () => {
    const config = { ...hosted, S2_DEPLOYMENT_LOGS_SKIP_ACCESS_TOKENS: "1" };
    expect(skipsAccessTokens(config)).toBe(true);
    expect(cliCanFollow(config)).toBe(false);
  });

  it("ignores the build log settings when S2 is off", () => {
    const config = {
      S2_ENABLED: "0",
      S2_DEPLOYMENT_LOGS_ENDPOINT: "http://s2/v1",
      S2_DEPLOYMENT_LOGS_SKIP_ACCESS_TOKENS: "1",
    };
    expect(publicEndpoint(config)).toBeUndefined();
    expect(skipsAccessTokens(config)).toBe(false);
  });
});
