import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Each snippet is its own copyable CodeBlock, so it has to stand alone as a file.
const SNIPPET_FILES = [
  "app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam._index/route.tsx",
  "app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.tasks.dashboard/route.tsx",
];

type Snippet = { name: string; body: string };

function readSnippets(file: string): Snippet[] {
  const source = readFileSync(join(__dirname, "..", file), "utf8");
  const snippets: Snippet[] = [];
  const declaration = /^const ([A-Z0-9_]*(?:CODE|EXAMPLE)) = `([\s\S]*?)`;$/gm;
  for (const match of source.matchAll(declaration)) {
    snippets.push({ name: match[1], body: match[2] });
  }
  return snippets;
}

function importedNames(body: string): Set<string> {
  const names = new Set<string>();
  for (const match of body.matchAll(/import \{([^}]*)\} from "@trigger\.dev\/sdk[^"]*";/g)) {
    for (const name of match[1].split(",")) {
      const trimmed = name.trim();
      if (trimmed) names.add(trimmed);
    }
  }
  return names;
}

// `export const helloWorld = task({` and `= schedules.task({` both root at their first identifier.
function usedNames(body: string): Set<string> {
  const names = new Set<string>();
  for (const match of body.matchAll(/^export const \w+ = ([A-Za-z_$][\w$]*)[.(]/gm)) {
    names.add(match[1]);
  }
  return names;
}

describe("task code snippets", () => {
  const snippets = SNIPPET_FILES.flatMap((file) =>
    readSnippets(file).map((snippet) => ({ ...snippet, file }))
  );

  it("finds every snippet in both files", () => {
    expect(snippets.map((s) => s.name).sort()).toEqual([
      "AGENT_EXAMPLE",
      "CHAT_AGENT_CODE",
      "SCHEDULED_EXAMPLE",
      "SCHEDULED_TASK_CODE",
      "STANDARD_EXAMPLE",
      "STANDARD_TASK_CODE",
    ]);
  });

  it.each(snippets)("$name imports every SDK symbol it uses", ({ name, body }) => {
    const used = usedNames(body);
    expect(used.size, `${name} declares no task`).toBeGreaterThan(0);

    const imported = importedNames(body);
    for (const symbol of used) {
      expect(imported, `${name} uses "${symbol}" without importing it`).toContain(symbol);
    }
  });

  it.each(snippets)("$name imports nothing it does not use", ({ name, body }) => {
    const used = usedNames(body);
    for (const symbol of importedNames(body)) {
      expect(used, `${name} imports "${symbol}" but never uses it`).toContain(symbol);
    }
  });
});
