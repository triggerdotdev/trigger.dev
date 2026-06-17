import { describe, expect, it } from "vitest";
import { getTriggerDependencies, getVersionMismatches, type Dependency } from "./update.js";

describe("update command dependency checks", () => {
  it("skips unresolved package-manager protocol specifiers", async () => {
    const deps = await getTriggerDependencies(
      {
        dependencies: {
          "@trigger.dev/sdk": "catalog:",
          "@trigger.dev/core": "workspace:4.5.0",
          "@trigger.dev/build": "file:../build",
          react: "^19.0.0",
        },
        devDependencies: {
          "@trigger.dev/eslint-plugin": "link:../eslint-plugin",
        },
      },
      "/tmp/trigger-catalog-repro/package.json"
    );

    expect(deps).toEqual([]);
  });

  it("keeps normal trigger dependencies for version mismatch checks", async () => {
    const deps = await getTriggerDependencies(
      {
        dependencies: {
          "@trigger.dev/sdk": "4.4.6",
        },
      },
      "/tmp/trigger-version-repro/package.json"
    );

    expect(deps).toEqual([
      {
        type: "dependencies",
        name: "@trigger.dev/sdk",
        version: "4.4.6",
      },
    ]);
  });

  it("does not throw when an invalid specifier reaches downgrade detection", () => {
    const deps: Dependency[] = [
      {
        type: "dependencies",
        name: "@trigger.dev/sdk",
        version: "catalog:",
      },
    ];

    expect(() => getVersionMismatches(deps, "4.5.0")).not.toThrow();
    expect(getVersionMismatches(deps, "4.5.0")).toEqual({
      mismatches: deps,
      isDowngrade: false,
    });
  });

  it("still detects downgrade prompts for valid semver ranges", () => {
    const deps: Dependency[] = [
      {
        type: "dependencies",
        name: "@trigger.dev/sdk",
        version: "^5.0.0",
      },
    ];

    expect(getVersionMismatches(deps, "4.5.0")).toEqual({
      mismatches: deps,
      isDowngrade: true,
    });
  });
});
