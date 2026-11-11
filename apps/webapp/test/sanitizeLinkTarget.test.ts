import { describe, expect, it } from "vitest";
import { sanitizeLinkTarget } from "~/utils/sanitizeUrl";

describe("sanitizeLinkTarget", () => {
  it("keeps app paths and relative targets", () => {
    expect(sanitizeLinkTarget("/orgs/acme/projects")).toBe("/orgs/acme/projects");
    expect(sanitizeLinkTarget("/runs?status=failed#top")).toBe("/runs?status=failed#top");
    expect(sanitizeLinkTarget("settings")).toBe("settings");
    expect(sanitizeLinkTarget("../runs")).toBe("../runs");
    expect(sanitizeLinkTarget("?tab=logs")).toBe("?tab=logs");
    expect(sanitizeLinkTarget("#section")).toBe("#section");
  });

  it("keeps http and https URLs", () => {
    expect(sanitizeLinkTarget("https://trigger.dev/docs/v3/machines")).toBe(
      "https://trigger.dev/docs/v3/machines"
    );
    expect(sanitizeLinkTarget("http://localhost:3030/login")).toBe("http://localhost:3030/login");
    expect(sanitizeLinkTarget("HTTPS://trigger.dev/docs")).toBe("https://trigger.dev/docs");
  });

  it("returns undefined for other schemes", () => {
    expect(sanitizeLinkTarget("javascript:void(0)")).toBeUndefined();
    expect(sanitizeLinkTarget("JavaScript:void(0)")).toBeUndefined();
    expect(sanitizeLinkTarget("data:text/html,hello")).toBeUndefined();
    expect(sanitizeLinkTarget("vbscript:msgbox")).toBeUndefined();
    expect(sanitizeLinkTarget("mailto:hello@trigger.dev")).toBeUndefined();
  });

  it("returns undefined for targets on another host without a scheme", () => {
    expect(sanitizeLinkTarget("//example.com/path")).toBeUndefined();
    expect(sanitizeLinkTarget("/\\example.com/path")).toBeUndefined();
    expect(sanitizeLinkTarget("\\\\example.com/path")).toBeUndefined();
  });

  it("returns undefined for relative paths that leave the app path", () => {
    expect(sanitizeLinkTarget("../javascript:void(0)")).toBeUndefined();
    expect(sanitizeLinkTarget("./../data:text/html,hello")).toBeUndefined();
    expect(sanitizeLinkTarget("../javascript:void(0)/..")).toBeUndefined();
    expect(sanitizeLinkTarget("..///example.com")).toBeUndefined();
    expect(sanitizeLinkTarget("runs/..//example.com")).toBeUndefined();
    expect(sanitizeLinkTarget("\\example.com")).toBeUndefined();
    expect(sanitizeLinkTarget("..\\example.com")).toBeUndefined();
  });

  it("keeps app paths that contain a colon or double slash", () => {
    expect(sanitizeLinkTarget("/resources/packets/env_1/s3://bucket/output.json")).toBe(
      "/resources/packets/env_1/s3://bucket/output.json"
    );
    expect(sanitizeLinkTarget("runs/run_1:attempt")).toBe("runs/run_1:attempt");
  });

  it("reads the target the way a browser does", () => {
    expect(sanitizeLinkTarget("java\tscript:void(0)")).toBeUndefined();
    expect(sanitizeLinkTarget("java\nscript:void(0)")).toBeUndefined();
    expect(sanitizeLinkTarget("  javascript:void(0)")).toBeUndefined();
    expect(sanitizeLinkTarget("\u0001javascript:void(0)")).toBeUndefined();
    expect(sanitizeLinkTarget("/\t/example.com")).toBeUndefined();
    expect(sanitizeLinkTarget(" /runs ")).toBe("/runs");
  });
});
