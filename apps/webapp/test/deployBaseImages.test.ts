import { describe, expect, it } from "vitest";
import { resolveDeployBaseImages } from "~/v3/deployBaseImages.server";

describe("resolveDeployBaseImages", () => {
  it("returns undefined when nothing is configured", () => {
    expect(resolveDeployBaseImages("node-26", {})).toBeUndefined();
  });

  it("returns the images configured for the runtime", () => {
    expect(
      resolveDeployBaseImages("node-26", {
        base: "node-24=acme/node-fips:24@sha256:aaa, node-26=acme/node-fips:26@sha256:bbb",
        buildBase: "node-26=acme/node:26-dev@sha256:ccc",
      })
    ).toEqual({ base: "acme/node-fips:26@sha256:bbb", buildBase: "acme/node:26-dev@sha256:ccc" });
  });

  it("returns undefined for runtimes without an entry", () => {
    expect(resolveDeployBaseImages("bun", { base: "node-26=acme/node-fips:26" })).toBeUndefined();
  });

  it("returns undefined when the deployment has no runtime", () => {
    expect(resolveDeployBaseImages(null, { base: "node-26=acme/node-fips:26" })).toBeUndefined();
  });

  it("skips malformed entries", () => {
    expect(
      resolveDeployBaseImages("node-26", { base: "garbage,=nope,node-26=,node-26=acme/node:26" })
    ).toEqual({ base: "acme/node:26" });
  });
});
