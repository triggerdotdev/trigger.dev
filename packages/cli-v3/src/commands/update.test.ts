import { describe, expect, it } from "vitest";
import { getTriggerDependencies, getVersionMismatches, type Dependency } from "./update.js";

describe("getTriggerDependencies", () => {
  it("skips dependencies using catalog: and workspace: protocols", async () => {
    const packageJson = {
      dependencies: {
        "@trigger.dev/sdk": "catalog:",
        "@trigger.dev/core": "catalog:default",
        "@trigger.dev/react-hooks": "workspace:*",
        lodash: "^4.17.21",
      },
      devDependencies: {
        "@trigger.dev/build": "catalog:tools",
        "@trigger.dev/schema-to-json": "workspace:^3.0.0",
        "@trigger.dev/companyicons": "^1.0.0",
      },
    };

    const deps = await getTriggerDependencies(packageJson, "/fake/project/package.json");

    expect(deps).toEqual([]);
  });

  it("includes normal @trigger.dev dependencies", async () => {
    const packageJson = {
      dependencies: {
        "@trigger.dev/sdk": "^3.0.0",
      },
      devDependencies: {
        "@trigger.dev/core": "~3.0.0",
      },
    };

    const deps = await getTriggerDependencies(packageJson, "/fake/project/package.json");

    expect(deps).toHaveLength(2);
    expect(deps).toContainEqual({
      type: "dependencies",
      name: "@trigger.dev/sdk",
      version: "^3.0.0",
    });
    expect(deps).toContainEqual({
      type: "devDependencies",
      name: "@trigger.dev/core",
      version: "~3.0.0",
    });
  });
});

describe("getVersionMismatches", () => {
  it("does not throw when encountering non-semver strings like catalog: or workspace:", () => {
    const deps: Dependency[] = [
      {
        type: "dependencies",
        name: "@trigger.dev/sdk",
        version: "catalog:",
      },
      {
        type: "dependencies",
        name: "@trigger.dev/core",
        version: "catalog:named",
      },
      {
        type: "devDependencies",
        name: "@trigger.dev/build",
        version: "workspace:*",
      },
      {
        type: "devDependencies",
        name: "@trigger.dev/react-hooks",
        version: "invalid-semver-string",
      },
    ];

    expect(() => getVersionMismatches(deps, "3.0.0")).not.toThrow();

    const { mismatches, isDowngrade } = getVersionMismatches(deps, "3.0.0");
    expect(mismatches).toHaveLength(4);
    expect(isDowngrade).toBe(false);
  });

  it("correctly identifies downgrades when valid semver is newer than target CLI version", () => {
    const deps: Dependency[] = [
      {
        type: "dependencies",
        name: "@trigger.dev/sdk",
        version: "^4.0.0",
      },
    ];

    const { mismatches, isDowngrade } = getVersionMismatches(deps, "3.0.0");
    expect(mismatches).toHaveLength(1);
    expect(isDowngrade).toBe(true);
  });

  it("ignores packages matching targetVersion, 0.0.0, or pkg.pr.new", () => {
    const deps: Dependency[] = [
      {
        type: "dependencies",
        name: "@trigger.dev/sdk",
        version: "3.0.0",
      },
      {
        type: "dependencies",
        name: "@trigger.dev/core",
        version: "0.0.0-prerelease",
      },
      {
        type: "devDependencies",
        name: "@trigger.dev/build",
        version: "https://pkg.pr.new/@trigger.dev/build@123",
      },
    ];

    const { mismatches, isDowngrade } = getVersionMismatches(deps, "3.0.0");
    expect(mismatches).toHaveLength(0);
    expect(isDowngrade).toBe(false);
  });
});
