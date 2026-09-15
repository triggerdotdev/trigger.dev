import { describe, it, expect } from "vitest";
import {
  createDefaultVercelIntegrationData,
  restrictConfigToAvailableEnvSlugs,
} from "../app/v3/vercel/vercelProjectIntegrationSchema";

const STAGING_ENV = { environmentId: "env_123", displayName: "Staging" };

describe("restrictConfigToAvailableEnvSlugs", () => {
  it("drops slugs the project has no environment for", () => {
    const restricted = restrictConfigToAvailableEnvSlugs(
      {
        atomicBuilds: ["prod", "stg"],
        pullEnvVarsBeforeBuild: ["prod", "preview"],
        discoverEnvVars: ["dev", "stg", "preview"],
      },
      ["dev", "prod"]
    );

    expect(restricted.atomicBuilds).toEqual(["prod"]);
    expect(restricted.pullEnvVarsBeforeBuild).toEqual(["prod"]);
    expect(restricted.discoverEnvVars).toEqual(["dev"]);
  });

  it("keeps slugs the project does have", () => {
    const restricted = restrictConfigToAvailableEnvSlugs(
      { atomicBuilds: ["prod", "stg", "preview"] },
      ["dev", "stg", "prod", "preview"]
    );

    expect(restricted.atomicBuilds).toEqual(["prod", "stg", "preview"]);
  });

  it("only touches keys present on the input", () => {
    const restricted = restrictConfigToAvailableEnvSlugs({ atomicBuilds: ["stg"] }, ["prod"]);

    expect(restricted).not.toHaveProperty("pullEnvVarsBeforeBuild");
    expect(restricted).not.toHaveProperty("discoverEnvVars");
    expect(restricted).not.toHaveProperty("vercelStagingEnvironment");
  });

  it("clears the staging environment mapping when staging is unavailable", () => {
    const restricted = restrictConfigToAvailableEnvSlugs(
      { vercelStagingEnvironment: STAGING_ENV },
      ["dev", "prod", "preview"]
    );

    expect(restricted.vercelStagingEnvironment).toBeNull();
  });

  it("keeps the staging environment mapping when staging is available", () => {
    const restricted = restrictConfigToAvailableEnvSlugs(
      { vercelStagingEnvironment: STAGING_ENV },
      ["dev", "stg", "prod"]
    );

    expect(restricted.vercelStagingEnvironment).toEqual(STAGING_ENV);
  });

  it("does not mutate the input", () => {
    const config = { atomicBuilds: ["prod", "stg"] as const };
    restrictConfigToAvailableEnvSlugs({ atomicBuilds: [...config.atomicBuilds] }, ["prod"]);

    expect(config.atomicBuilds).toEqual(["prod", "stg"]);
  });
});

describe("createDefaultVercelIntegrationData", () => {
  it("does not enable preview for a project without a preview environment", () => {
    const data = createDefaultVercelIntegrationData("prj_1", "My project", null, undefined, [
      "dev",
      "prod",
    ]);

    expect(data.config.pullEnvVarsBeforeBuild).toEqual(["prod"]);
    expect(data.config.discoverEnvVars).toEqual(["prod"]);
  });

  it("enables preview when the project has a preview environment", () => {
    const data = createDefaultVercelIntegrationData("prj_1", "My project", null, undefined, [
      "dev",
      "stg",
      "prod",
      "preview",
    ]);

    expect(data.config.pullEnvVarsBeforeBuild).toEqual(["prod", "preview"]);
    expect(data.config.discoverEnvVars).toEqual(["prod", "preview"]);
  });

  it("never turns atomic builds on by default", () => {
    const data = createDefaultVercelIntegrationData("prj_1", "My project", null, undefined, [
      "dev",
      "stg",
      "prod",
      "preview",
    ]);

    expect(data.config.atomicBuilds).toEqual([]);
    expect(data.config.vercelStagingEnvironment).toBeNull();
  });
});
