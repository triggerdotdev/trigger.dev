import { describe, expect, it } from "vitest";
import { parseDeployBaseImages, resolveDeployBaseImages } from "~/v3/deployBaseImages.server";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const digestC = `sha256:${"c".repeat(64)}`;

describe("parseDeployBaseImages", () => {
  it("returns an empty map for undefined and empty values", () => {
    const empty = { images: {}, errors: [] };
    expect(parseDeployBaseImages(undefined, "DEPLOY_BASE_IMAGES")).toEqual(empty);
    expect(parseDeployBaseImages("", "DEPLOY_BASE_IMAGES")).toEqual(empty);
    expect(parseDeployBaseImages(" , ,", "DEPLOY_BASE_IMAGES")).toEqual(empty);
  });

  it("parses multiple entries and trims whitespace", () => {
    expect(
      parseDeployBaseImages(
        ` node-24 = acme/node-fips:24@${digestA} , bun=acme/bun:1@${digestB},`,
        "DEPLOY_BASE_IMAGES"
      )
    ).toEqual({
      images: {
        "node-24": `acme/node-fips:24@${digestA}`,
        bun: `acme/bun:1@${digestB}`,
      },
      errors: [],
    });
  });

  it("accepts a registry with a port and a tag before the digest", () => {
    const image = `registry.example.com:5000/ns/img:tag@${digestA}`;
    expect(parseDeployBaseImages(`node-24=${image}`, "DEPLOY_BASE_IMAGES")).toEqual({
      images: { "node-24": image },
      errors: [],
    });
  });

  it.each([
    ["missing =", "garbage"],
    ["unknown runtime", `node-23=acme/node:23@${digestA}`],
    ["node alias", `node=acme/node:24@${digestA}`],
    ["empty image", "node-24="],
    ["missing digest", "node-24=acme/node:24"],
    ["flag before image", `node-24=--platform=linux/arm64 acme/node@${digestA}`],
    ["bare digest", `node-24=@${digestA}`],
    ["newline in image", `node-24=acme/node\nx@${digestA}`],
    ["duplicate runtime", `node-24=acme/a@${digestA},node-24=acme/b@${digestB}`],
  ])("reports an error naming the env var and segment: %s", (_name, value) => {
    const segments = value.split(",");
    const offending = segments[segments.length - 1]!.trim();

    const { images, errors } = parseDeployBaseImages(
      `node-22=acme/ok@${digestC},${value}`,
      "DEPLOY_BUILD_BASE_IMAGES"
    );

    expect(images["node-22"]).toBe(`acme/ok@${digestC}`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("DEPLOY_BUILD_BASE_IMAGES");
    expect(errors[0]).toContain(offending);
  });

  it("explains that node is an alias", () => {
    const { errors } = parseDeployBaseImages(`node=acme/node@${digestA}`, "DEPLOY_BASE_IMAGES");
    expect(errors[0]).toContain('runtime "node" is an alias; use the concrete runtime');
  });

  it("reports every bad segment", () => {
    const { errors } = parseDeployBaseImages(
      `garbage,node-23=acme/node@${digestA},bun=acme/bun`,
      "DEPLOY_BASE_IMAGES"
    );
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain("garbage");
    expect(errors[1]).toContain("node-23");
    expect(errors[2]).toContain("bun=acme/bun");
  });
});

describe("resolveDeployBaseImages", () => {
  const base = { "node-26": `acme/node-fips:26@${digestA}` } as const;
  const buildBase = { "node-26": `acme/node:26-dev@${digestB}` } as const;

  it("returns undefined for a missing or unknown runtime", () => {
    expect(resolveDeployBaseImages("node-23", { base, buildBase })).toBeUndefined();
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
