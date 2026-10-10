import { describe, expect, it } from "vitest";
import { resolveImageBaseOverrides } from "./bundle.js";

const config = (image?: { base?: string; buildBase?: string }) => ({
  build: {
    jsx: { factory: "h", fragment: "F", automatic: true as const },
    image,
  },
});

describe("resolveImageBaseOverrides", () => {
  it("returns undefined when nothing is configured", () => {
    expect(resolveImageBaseOverrides(config(), {})).toBeUndefined();
  });

  it("reads build.image from the config", () => {
    expect(
      resolveImageBaseOverrides(
        config({ base: "acme/node-fips:26", buildBase: "acme/node:26-dev" }),
        {}
      )
    ).toEqual({ base: "acme/node-fips:26", buildBase: "acme/node:26-dev" });
  });

  it("prefers the environment variables over the config", () => {
    expect(
      resolveImageBaseOverrides(config({ base: "from-config", buildBase: "from-config-build" }), {
        TRIGGER_BUILD_BASE_IMAGE: "from-env",
      })
    ).toEqual({ base: "from-env", buildBase: "from-config-build" });
  });

  it("ignores empty environment variables", () => {
    expect(
      resolveImageBaseOverrides(config({ base: "from-config" }), {
        TRIGGER_BUILD_BASE_IMAGE: "",
        TRIGGER_BUILD_BUILD_IMAGE: "",
      })
    ).toEqual({ base: "from-config" });
  });
});
