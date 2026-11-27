import { describe, expect, it } from "vitest";
import { buildPrompt, isPromptPage, stepsToMarkdown } from "./copy-prompt";

describe("copy prompt", () => {
  it("turns Steps into numbered headings, restarting per Steps block", () => {
    const md = `<Steps titleSize="h3">\n<Step title="Install">\nrun it\n</Step>\n<Step title='Run'>\ngo\n</Step>\n</Steps>\n\n<Steps>\n  <Step>\nagain\n  </Step>\n</Steps>`;
    expect(stepsToMarkdown(md)).toBe(
      "### Step 1: Install\nrun it\n### Step 2: Run\ngo\n\n### Step 1\nagain"
    );
  });

  it("drops frontmatter and names the page and its .md URL", () => {
    const prompt = buildPrompt(
      `---\ntitle: "Quick start"\n---\n\n# Quick start\n\nDo it.`,
      "Quick start",
      "https://trigger.dev/docs/quick-start.md"
    );
    expect(prompt).toContain(`"Quick start"`);
    expect(prompt).toContain("https://trigger.dev/docs/quick-start.md");
    expect(prompt).not.toContain("title:");
    expect(prompt).toContain("<docs-page>\n# Quick start\n\nDo it.\n</docs-page>");
  });

  it("shows on guides and on pages with steps", () => {
    expect(isPromptPage("Guides & examples", "")).toBe(true);
    expect(isPromptPage("Documentation", "a <Steps> b")).toBe(true);
    expect(isPromptPage("Documentation", "plain")).toBe(false);
  });
});
