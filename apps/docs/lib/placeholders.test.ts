import { describe, expect, it } from "vitest";
import { fillParts, fillPlaceholders, findPlaceholders } from "./placeholders";

describe("placeholders", () => {
  it.each([
    'project: "<project ref>",',
    'project: "<your-project-ref>",',
    'project: "<project-ref>",',
    'project: "<project id>",',
    'project: "proj_your_project_id_here",',
    "TRIGGER_PROJECT_REF=proj_xxxxxxxxxxxxxxxxxxxxxxxx",
    'runs.list("proj_1234", {',
    "npx trigger.dev@latest projects get proj_abc123",
  ])("fills the project ref in %s", (line) => {
    expect(findPlaceholders(line).projectRef).toBe(true);
    expect(fillPlaceholders(line, { projectRef: "proj_mine" })).toContain("proj_mine");
  });

  it.each([
    "TRIGGER_SECRET_KEY=tr_dev_sk_...",
    "TRIGGER_SECRET_KEY=tr_dev_sk_xxxxxxxxxx",
    "TRIGGER_SECRET_KEY=tr_dev_xxxxxxxxxxxxxxxxxxxxxxxx",
  ])("fills the dev key in %s", (line) => {
    expect(findPlaceholders(line).devKey).toBe(true);
    expect(fillPlaceholders(line, { devKey: "tr_dev_mine" })).toBe(
      "TRIGGER_SECRET_KEY=tr_dev_mine"
    );
  });

  // Catches: a prod key placeholder or another product's id replaced with the reader's dev values.
  it.each([
    'TRIGGER_SECRET_KEY="tr_prod_sk_…"',
    'TRIGGER_SECRET_KEY="tr_preview_sk_1234567890"',
    "https://supabase.com/dashboard/project/<your-project-id>/functions",
    "your-registry.example.com/your-company/proj_123:20250625.1.prod",
    'project: "<your-sentry-project>",',
    "proj_12345678",
  ])("leaves %s alone", (line) => {
    expect(findPlaceholders(line)).toEqual({ projectRef: false, devKey: false });
    expect(fillPlaceholders(line, { projectRef: "proj_mine", devKey: "tr_dev_mine" })).toBe(line);
  });

  // Catches: shell samples (`--project-ref <project-ref>`) staying unfilled because the highlighter
  // splits the placeholder into `<`, `project-ref` and `>` tokens.
  it("fills a placeholder split across highlighter tokens", () => {
    const parts = [
      " --project-ref",
      " <",
      "your-project-re",
      "f",
      ">",
      " && echo tr_dev_",
      "sk_...",
    ];
    const filled = fillParts(parts, { projectRef: "proj_mine", devKey: "tr_dev_mine" });
    expect(filled.join("")).toBe(" --project-ref proj_mine && echo tr_dev_mine");
    expect(filled).toEqual([
      " --project-ref",
      " proj_mine",
      "",
      "",
      "",
      " && echo tr_dev_mine",
      "",
    ]);
    expect(fillParts(parts, {})).toEqual(parts);
  });
});
