import { describe, expect, it } from "vitest";
import type { BuildContext, BuildLayer } from "@trigger.dev/core/v3/build";
import { syncEnvVars, type SyncEnvVarsFunction } from "./syncEnvVars.js";

async function runExtension(fn: SyncEnvVarsFunction): Promise<BuildLayer | undefined> {
  let captured: BuildLayer | undefined;

  const context = {
    target: "deploy",
    config: { project: "proj_test" },
    logger: {
      spinner: () => ({ stop: () => {} }),
    },
    addLayer: (layer: BuildLayer) => {
      captured = layer;
    },
  } as unknown as BuildContext;

  const manifest = {
    deploy: { env: {} },
    environment: "prod",
    branch: undefined,
  } as any;

  const extension = syncEnvVars(fn);
  await extension.onBuildComplete!(context, manifest);

  return captured;
}

describe("syncEnvVars isSecret", () => {
  it("partitions secret and non-secret vars across child and parent", async () => {
    const layer = await runExtension(() => [
      { name: "PUBLIC_URL", value: "https://example.com" },
      { name: "API_KEY", value: "secret-key", isSecret: true },
      { name: "PARENT_PUBLIC", value: "parent", isParentEnv: true },
      { name: "PARENT_SECRET", value: "parent-secret", isParentEnv: true, isSecret: true },
    ]);

    expect(layer?.deploy?.env).toEqual({ PUBLIC_URL: "https://example.com" });
    expect(layer?.deploy?.secretEnv).toEqual({ API_KEY: "secret-key" });
    expect(layer?.deploy?.parentEnv).toEqual({ PARENT_PUBLIC: "parent" });
    expect(layer?.deploy?.secretParentEnv).toEqual({ PARENT_SECRET: "parent-secret" });
  });

  it("treats the record form as all non-secret", async () => {
    const layer = await runExtension(() => ({ DATABASE_URL: "postgres://..." }));

    expect(layer?.deploy?.env).toEqual({ DATABASE_URL: "postgres://..." });
    expect(layer?.deploy?.secretEnv).toBeUndefined();
    expect(layer?.deploy?.secretParentEnv).toBeUndefined();
  });

  it("omits secret buckets when no var is marked secret", async () => {
    const layer = await runExtension(() => [{ name: "PUBLIC_URL", value: "https://example.com" }]);

    expect(layer?.deploy?.env).toEqual({ PUBLIC_URL: "https://example.com" });
    expect(layer?.deploy?.secretEnv).toBeUndefined();
    expect(layer?.deploy?.secretParentEnv).toBeUndefined();
  });
});
