// Guards the tree-shape invariant: DashboardAgent.tsx must mount FloatingAgentWindow
// exactly once, never branch it behind a mode check, and gate the right-column sizing
// on `mode === "rightPanel"` rather than swapping in a whole separate element tree.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = __dirname;

function read(file: string): string {
  return readFileSync(join(DIR, file), "utf8");
}

describe("DashboardAgent.tsx keeps one tree shape across display modes", () => {
  const source = read("DashboardAgent.tsx");

  it("mounts FloatingAgentWindow exactly once, unconditionally", () => {
    const occurrences = source.match(/<FloatingAgentWindow\b/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it("renders the open panel through FloatingAgentWindow", () => {
    expect(source).toContain("FloatingAgentWindow");
  });

  it("saves the docked width on drag end, never on a size report", () => {
    expect(source).toContain("onDragEnd={onAgentHandleDragEnd}");
    expect(source).toContain("createDockedWidthController");
    // Persistence goes through the controller, which blocks it until a dock has applied
    // its own width; writing straight from a size report is the bug it exists for.
    expect(source).not.toMatch(/writeAgentPanelWidth\(pixel/);
  });

  it("renders a constant default width, so the server and the client agree", () => {
    expect(source).toContain('default={docked ? `${AGENT_PANEL_DEFAULT_WIDTH}px` : "0px"}');
    expect(source).not.toMatch(/default=\{[^}]*readAgentPanelWidth/);
  });

  it("gates the right-column sizing on constraints, never the library's collapse state", () => {
    expect(source).toContain('min={docked ? `${AGENT_PANEL_MIN_WIDTH}px` : "0px"}');
    expect(source).toContain('max={docked ? `${AGENT_PANEL_MAX_WIDTH}px` : "0px"}');
    expect(source).not.toMatch(/collapsed=\{/);
    expect(source).not.toContain("collapsedSize");
  });

  it("keeps ResizableHandle always mounted — a conditional handle shifts sibling keys and remounts the chat", () => {
    const occurrences = source.match(/<ResizableHandle\b/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(source).not.toMatch(/docked &&\s*<ResizableHandle/);
    expect(source).toContain('size={docked ? "3px" : "0px"}');
  });

  it("unclips the degenerate panel with Tailwind v4's trailing-bang important modifier", () => {
    expect(source).toContain('"overflow-visible!"');
    expect(source).not.toContain('"!overflow-visible"');
  });
});
