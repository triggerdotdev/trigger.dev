// Guards against reintroducing the old right-column ResizablePanelGroup.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = __dirname;

function read(file: string): string {
  return readFileSync(join(DIR, file), "utf8");
}

describe("DashboardAgent.tsx stays on the floating window, not the right-column mode", () => {
  const source = read("DashboardAgent.tsx");

  it("never reintroduces the right-column ResizablePanelGroup", () => {
    expect(source).not.toContain("ResizablePanelGroup");
    expect(source).not.toContain("ResizablePanel");
    expect(source).not.toContain("ResizableHandle");
  });

  it("renders the open panel through FloatingAgentWindow", () => {
    expect(source).toContain("FloatingAgentWindow");
  });
});
