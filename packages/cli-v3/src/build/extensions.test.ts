import { describe, expect, test } from "vitest";
import type { ResolvedConfig } from "@trigger.dev/core/v3/build";
import type { BuildManifest } from "@trigger.dev/core/v3/schemas";
import { syncEnvVars } from "../../../build/src/extensions/core/syncEnvVars.js";
import { createBuildContext, notifyExtensionOnBuildComplete } from "./extensions.js";

const buckets = ["env", "parentEnv", "secretEnv", "secretParentEnv"] as const;

describe("syncEnvVars through the deployment layer merger", () => {
  test.each(buckets)("preserves empty values in %s", async (bucket) => {
    const extension = syncEnvVars(() =>
      [
        { name: "CLEAR", value: "" },
        { name: "NEW_EMPTY", value: "" },
        { name: "UNCHANGED", value: "" },
        { name: "SPACE", value: "  " },
      ].map((item) => ({
        ...item,
        isSecret: bucket === "secretEnv" || bucket === "secretParentEnv",
        isParentEnv: bucket === "parentEnv" || bucket === "secretParentEnv",
      }))
    );
    const context = createBuildContext(
      "deploy",
      {
        project: "proj_test",
        workingDir: process.cwd(),
        build: { extensions: [extension] },
      } as ResolvedConfig,
      { allowEmptyEnvironmentVariableValues: true }
    );
    const manifest = await notifyExtensionOnBuildComplete(context, {
      environment: "prod",
      build: {},
      deploy: { env: { CLEAR: "old", UNCHANGED: "" } },
    } as BuildManifest);

    expect(manifest.deploy.sync?.[bucket]).toEqual({ CLEAR: "", NEW_EMPTY: "", SPACE: "  " });
  });

  test("override false protects existing values but allows a new empty variable", async () => {
    const context = createBuildContext(
      "deploy",
      {
        project: "proj_test",
        workingDir: process.cwd(),
        build: {
          extensions: [syncEnvVars(() => ({ EXISTING: "", NEW_EMPTY: "" }), { override: false })],
        },
      } as ResolvedConfig,
      { allowEmptyEnvironmentVariableValues: true }
    );
    const manifest = await notifyExtensionOnBuildComplete(context, {
      environment: "prod",
      build: {},
      deploy: { env: { EXISTING: "keep" } },
    } as BuildManifest);

    expect(manifest.deploy.sync?.env).toEqual({ NEW_EMPTY: "" });
  });
});

test.each([undefined, false])(
  "a missing or disabled server capability (%s) skips empty sync values",
  async (enabled) => {
    const context = createBuildContext(
      "deploy",
      {
        project: "proj_test",
        workingDir: process.cwd(),
        build: {
          extensions: [
            syncEnvVars(() => [
              { name: "EMPTY", value: "" },
              { name: "SECRET_EMPTY", value: "", isSecret: true },
              { name: "PARENT_EMPTY", value: "", isParentEnv: true },
              { name: "PARENT_SECRET_EMPTY", value: "", isParentEnv: true, isSecret: true },
              { name: "SET", value: "new" },
            ]),
          ],
        },
      } as ResolvedConfig,
      { allowEmptyEnvironmentVariableValues: enabled }
    );
    const manifest = await notifyExtensionOnBuildComplete(context, {
      environment: "prod",
      build: {},
      deploy: { env: { EMPTY: "old" } },
    } as BuildManifest);
    expect(manifest.deploy.sync?.env).toEqual({ SET: "new" });
    expect(manifest.deploy.sync?.parentEnv).toEqual({});
    expect(manifest.deploy.sync?.secretEnv).toEqual({});
    expect(manifest.deploy.sync?.secretParentEnv).toEqual({});
  }
);
