import { afterEach, describe, expect, it, vi } from "vitest";
import { mdPath, modelContext, webMcpTools } from "./webmcp";

describe("WebMCP", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps paths and URLs to the page's .md", () => {
    expect(mdPath("tasks/overview")).toBe("/docs/tasks/overview.md");
    expect(mdPath("/docs/tasks/overview#retry")).toBe("/docs/tasks/overview.md");
    expect(mdPath("https://trigger.dev/docs/triggering?pm=pnpm")).toBe("/docs/triggering.md");
    expect(mdPath("/docs/quick-start.md")).toBe("/docs/quick-start.md");
  });

  it("is skipped without the API and found on document or navigator", () => {
    expect(modelContext()).toBeUndefined();
    const mc = { registerTool: vi.fn() };
    vi.stubGlobal("navigator", { modelContext: mc });
    expect(modelContext()).toBe(mc);
  });

  it("registers read-only search and read tools", () => {
    expect(webMcpTools.map((t) => t.name)).toEqual(["search_docs", "read_page"]);
    expect(webMcpTools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });
});
