import { describe, expect, it } from "vitest";
import { rewriteImageRegistry } from "./imageRegistry.js";

const FROM = "123456789012.dkr.ecr.us-east-1.amazonaws.com";
const TO = "123456789012.dkr.ecr.eu-central-1.amazonaws.com";

describe("rewriteImageRegistry", () => {
  it("rewrites the registry host and keeps the rest of the reference", () => {
    expect(rewriteImageRegistry(`${FROM}/deployments/proj_abc:20260818.1`, FROM, TO)).toBe(
      `${TO}/deployments/proj_abc:20260818.1`
    );
  });

  it("preserves a digest", () => {
    expect(rewriteImageRegistry(`${FROM}/deployments/proj_abc@sha256:abc123`, FROM, TO)).toBe(
      `${TO}/deployments/proj_abc@sha256:abc123`
    );
  });

  it("is a no-op unless both ends are configured", () => {
    const ref = `${FROM}/deployments/proj_abc:tag`;

    expect(rewriteImageRegistry(ref, undefined, TO)).toBe(ref);
    expect(rewriteImageRegistry(ref, FROM, undefined)).toBe(ref);
    expect(rewriteImageRegistry(ref, undefined, undefined)).toBe(ref);
  });

  it("leaves other registries alone", () => {
    const ref = "ghcr.io/triggerdotdev/something:tag";
    expect(rewriteImageRegistry(ref, FROM, TO)).toBe(ref);
  });

  it("only matches on a host boundary", () => {
    const lookalike = `${FROM}.evil.example.com/deployments/proj_abc:tag`;
    expect(rewriteImageRegistry(lookalike, FROM, TO)).toBe(lookalike);
  });

  it("does not rewrite a host that merely contains the source", () => {
    const ref = `registry.example.com/${FROM}/proj_abc:tag`;
    expect(rewriteImageRegistry(ref, FROM, TO)).toBe(ref);
  });
});
