import { describe, expect, it } from "vitest";
import { meteringClaims, regionForMetering } from "./meteringClaims.server";

describe("regionForMetering", () => {
  it("returns the explicit region when set", () => {
    expect(regionForMetering("eu-central-1", "eu-central-1-microvm")).toBe("eu-central-1");
  });

  it("returns the worker queue when it has no colon", () => {
    expect(regionForMetering(null, "us-nyc-3")).toBe("us-nyc-3");
  });

  it("returns the worker queue prefix before the first colon", () => {
    expect(regionForMetering(undefined, "us-nyc-3:scheduled")).toBe("us-nyc-3");
    expect(regionForMetering(undefined, "us-nyc-3:a:b")).toBe("us-nyc-3");
  });

  it("falls back to the worker queue when the region is empty", () => {
    expect(regionForMetering("", "us-nyc-3")).toBe("us-nyc-3");
  });

  it("returns undefined when neither is known", () => {
    expect(regionForMetering(null, null)).toBeUndefined();
    expect(regionForMetering(undefined, "")).toBeUndefined();
  });
});

describe("meteringClaims", () => {
  it("lowercases the environment type", () => {
    expect(meteringClaims({ environmentType: "PRODUCTION", region: "us-east-1" })).toEqual({
      environment_type: "production",
      region: "us-east-1",
    });
    expect(meteringClaims({ environmentType: "STAGING" }).environment_type).toBe("staging");
    expect(meteringClaims({ environmentType: "PREVIEW" }).environment_type).toBe("preview");
    expect(meteringClaims({ environmentType: "DEVELOPMENT" }).environment_type).toBe("development");
  });

  it("prefers the run's region over its worker queue", () => {
    expect(
      meteringClaims({
        environmentType: "PRODUCTION",
        region: "eu-central-1",
        workerQueue: "eu-central-1-microvm",
      })
    ).toEqual({ environment_type: "production", region: "eu-central-1" });
  });

  it("falls back to the worker queue prefix before the first colon", () => {
    expect(
      meteringClaims({
        environmentType: "PRODUCTION",
        region: null,
        workerQueue: "us-nyc-3:scheduled",
      })
    ).toEqual({ environment_type: "production", region: "us-nyc-3" });
  });

  it("treats an empty region as unknown", () => {
    expect(
      meteringClaims({ environmentType: "STAGING", region: "", workerQueue: "us-nyc-3" })
    ).toEqual({ environment_type: "staging", region: "us-nyc-3" });
  });

  it("omits region when neither region nor worker queue is known", () => {
    const claims = meteringClaims({ environmentType: "PRODUCTION", region: null, workerQueue: "" });

    expect(claims).toEqual({ environment_type: "production" });
    expect("region" in claims).toBe(false);
  });

  it("always reports development runs as local", () => {
    expect(
      meteringClaims({
        environmentType: "DEVELOPMENT",
        region: "cm_dev_environment_id",
        workerQueue: "cm_dev_environment_id",
      })
    ).toEqual({ environment_type: "development", region: "local" });
    expect(meteringClaims({ environmentType: "DEVELOPMENT" })).toEqual({
      environment_type: "development",
      region: "local",
    });
  });
});
