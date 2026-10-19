import { describe, expect, it } from "vitest";
import { environmentFromApiKey, resolveDeployEnvironment } from "./environment.js";

describe("environmentFromApiKey", () => {
  it("reads the environment from root and additional API keys", () => {
    expect(environmentFromApiKey("tr_prod_abc")).toBe("prod");
    expect(environmentFromApiKey("tr_stg_sk_abc")).toBe("staging");
    expect(environmentFromApiKey("tr_preview_abc")).toBe("preview");
    expect(environmentFromApiKey("tr_dev_abc")).toBe("dev");
  });

  it("ignores access tokens and missing values", () => {
    expect(environmentFromApiKey("tr_pat_abc")).toBeUndefined();
    expect(environmentFromApiKey("tr_oat_abc")).toBeUndefined();
    expect(environmentFromApiKey(undefined)).toBeUndefined();
    expect(environmentFromApiKey("")).toBeUndefined();
  });
});

describe("resolveDeployEnvironment", () => {
  it("defaults to prod when nothing is passed", () => {
    expect(resolveDeployEnvironment({})).toEqual({ env: "prod", source: "default" });
    expect(resolveDeployEnvironment({ accessToken: "tr_pat_abc" })).toEqual({
      env: "prod",
      source: "default",
    });
  });

  it("uses --env, normalizing production to prod", () => {
    expect(resolveDeployEnvironment({ env: "staging" })).toEqual({
      env: "staging",
      source: "flag",
    });
    expect(resolveDeployEnvironment({ env: "production" })).toEqual({
      env: "prod",
      source: "flag",
    });
  });

  it("treats --prod as --env prod", () => {
    expect(resolveDeployEnvironment({ prod: true })).toEqual({ env: "prod", source: "flag" });
    expect(resolveDeployEnvironment({ prod: true, env: "prod" })).toEqual({
      env: "prod",
      source: "flag",
    });
    expect(resolveDeployEnvironment({ prod: true, env: "production" })).toEqual({
      env: "prod",
      source: "flag",
    });
  });

  it("rejects --prod with another --env", () => {
    expect(() => resolveDeployEnvironment({ prod: true, env: "staging" })).toThrow(
      "--prod can't be combined with --env staging"
    );
  });

  it("uses the API key's environment when no flag is passed", () => {
    expect(resolveDeployEnvironment({ accessToken: "tr_stg_sk_abc" })).toEqual({
      env: "staging",
      source: "apiKey",
    });
    expect(resolveDeployEnvironment({ accessToken: "tr_preview_abc" })).toEqual({
      env: "preview",
      source: "apiKey",
    });
  });

  it("accepts a flag that matches the API key", () => {
    expect(resolveDeployEnvironment({ env: "staging", accessToken: "tr_stg_abc" })).toEqual({
      env: "staging",
      source: "flag",
    });
    expect(resolveDeployEnvironment({ prod: true, accessToken: "tr_prod_abc" })).toEqual({
      env: "prod",
      source: "flag",
    });
  });

  it("rejects a flag that doesn't match the API key", () => {
    expect(() => resolveDeployEnvironment({ env: "staging", accessToken: "tr_prod_abc" })).toThrow(
      "TRIGGER_ACCESS_TOKEN is a prod API key, but you asked for staging"
    );
    expect(() => resolveDeployEnvironment({ prod: true, accessToken: "tr_stg_abc" })).toThrow(
      "TRIGGER_ACCESS_TOKEN is a staging API key, but you asked for prod"
    );
  });

  it("rejects dev API keys", () => {
    expect(() => resolveDeployEnvironment({ accessToken: "tr_dev_abc" })).toThrow(
      "dev API key, which can't deploy"
    );
  });
});
