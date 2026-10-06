import { describe, expect, it } from "vitest";
import { parseDeployBaseImages, resolveDeployBaseImages } from "~/v3/deployBaseImages.server";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const digestC = `sha256:${"c".repeat(64)}`;

describe("parseDeployBaseImages", () => {
  it("returns an empty map for undefined and empty values", () => {
    expect(parseDeployBaseImages(undefined, "DEPLOY_BASE_IMAGES")).toEqual({});
    expect(parseDeployBaseImages("", "DEPLOY_BASE_IMAGES")).toEqual({});
    expect(parseDeployBaseImages(" , ,", "DEPLOY_BASE_IMAGES")).toEqual({});
  });

  it("parses multiple entries and trims whitespace", () => {
    expect(
      parseDeployBaseImages(
        ` node-24 = acme/node-fips:24@${digestA} , bun=acme/bun:1@${digestB},`,
        "DEPLOY_BASE_IMAGES"
      )
    ).toEqual({
      "node-24": `acme/node-fips:24@${digestA}`,
      bun: `acme/bun:1@${digestB}`,
    });
  });

  it.each([
    ["missing =", "garbage"],
    ["unknown runtime", `node-23=acme/node:23@${digestA}`],
    ["empty image", "node-24="],
    ["missing digest", "node-24=acme/node:24"],
    ["duplicate runtime", `node-24=acme/a@${digestA},node-24=acme/b@${digestB}`],
  ])("throws naming the env var and segment: %s", (_name, value) => {
    const segments = value.split(",");
    const offending = segments[segments.length - 1]!;

    let error: Error | undefined;
    try {
      parseDeployBaseImages(`node-22=acme/ok@${digestC},${value}`, "DEPLOY_BUILD_BASE_IMAGES");
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("DEPLOY_BUILD_BASE_IMAGES");
    expect(error?.message).toContain(offending);
  });
});

describe("resolveDeployBaseImages", () => {
  const base = { "node-26": `acme/node-fips:26@${digestA}` } as const;
  const buildBase = { "node-26": `acme/node:26-dev@${digestB}` } as const;

  it("returns undefined for an unknown runtime", () => {
    expect(resolveDeployBaseImages("node-23", { base, buildBase })).toBeUndefined();
  });

  it("returns undefined when the deployment has no runtime", () => {
    expect(resolveDeployBaseImages(null, { base, buildBase })).toBeUndefined();
    expect(resolveDeployBaseImages(undefined, { base, buildBase })).toBeUndefined();
  });

  it("returns undefined when the runtime has no entries", () => {
    expect(resolveDeployBaseImages("bun", { base, buildBase })).toBeUndefined();
    expect(resolveDeployBaseImages("node-26", { base: {}, buildBase: {} })).toBeUndefined();
  });

  it("returns both images", () => {
    expect(resolveDeployBaseImages("node-26", { base, buildBase })).toEqual({
      base: base["node-26"],
      buildBase: buildBase["node-26"],
    });
  });

  it("returns only the base image", () => {
    expect(resolveDeployBaseImages("node-26", { base, buildBase: {} })).toEqual({
      base: base["node-26"],
    });
  });

  it("returns only the build base image", () => {
    expect(resolveDeployBaseImages("node-26", { base: {}, buildBase })).toEqual({
      buildBase: buildBase["node-26"],
    });
  });
});
