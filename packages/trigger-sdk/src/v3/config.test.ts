import { describe, it, expect } from "vitest";
import { defineConfig } from "./config.js";

describe("defineConfig - maxComputeSeconds", () => {
  it("uses maxComputeSeconds when only maxComputeSeconds is set", () => {
    const cfg = defineConfig({ project: "p", maxComputeSeconds: 600 });
    expect(cfg.maxDuration).toBe(600);
  });

  it("uses maxDuration when only maxDuration is set", () => {
    const cfg = defineConfig({ project: "p", maxDuration: 600 });
    expect(cfg.maxDuration).toBe(600);
  });

  it("prefers maxComputeSeconds when both are set", () => {
    const cfg = defineConfig({ project: "p", maxComputeSeconds: 600, maxDuration: 9999 });
    expect(cfg.maxDuration).toBe(600);
  });

  it("leaves maxDuration unset when neither is provided", () => {
    const cfg = defineConfig({ project: "p" });
    expect(cfg.maxDuration).toBeUndefined();
  });

  it("strips maxComputeSeconds from the returned config", () => {
    const cfg = defineConfig({ project: "p", maxComputeSeconds: 600 });
    expect((cfg as { maxComputeSeconds?: number }).maxComputeSeconds).toBeUndefined();
  });
});
