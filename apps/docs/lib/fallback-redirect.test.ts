import { describe, expect, it } from "vitest";
import { fallbackRedirect } from "./fallback-redirect";

describe("fallbackRedirect", () => {
  const pages = ["/machines", "/tasks/overview", "/tasks/schemaTask", "/config/config-file"];
  const nav = ["/tasks/overview", "/tasks/schemaTask", "/config/config-file", "/machines"];

  it("sends a mixed-case path to its page", () => {
    expect(fallbackRedirect("/Machines", pages, nav)).toBe("/machines");
    expect(fallbackRedirect("/tasks/schematask", pages, nav)).toBe("/tasks/schemaTask");
  });

  it("sends a nav folder to its first page in nav order", () => {
    expect(fallbackRedirect("/tasks", pages, nav)).toBe("/tasks/overview");
    expect(fallbackRedirect("/Config", pages, nav)).toBe("/config/config-file");
  });

  it("leaves unknown paths and partial segments alone", () => {
    expect(fallbackRedirect("/nope", pages, nav)).toBeUndefined();
    expect(fallbackRedirect("/task", pages, nav)).toBeUndefined();
    expect(fallbackRedirect("/machines", pages, nav)).toBeUndefined();
  });
});
