import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../..");

function lint(source: string) {
  const file = join(__dirname, `formParserImports.${randomUUID()}.tmp.ts`);
  writeFileSync(file, source);
  try {
    const output = execFileSync(
      join(repoRoot, "node_modules/.bin/oxlint"),
      [
        "-c",
        join(repoRoot, ".oxlintrc.json"),
        "-A",
        "all",
        "-D",
        "no-restricted-imports",
        "-f",
        "json",
        file,
      ],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    return parse(output);
  } catch (error) {
    return parse((error as { stdout: string }).stdout);
  } finally {
    rmSync(file, { force: true });
  }
}

function parse(output: string): string[] {
  const { diagnostics } = JSON.parse(output) as { diagnostics: Array<{ code: string }> };
  return diagnostics.map((diagnostic) => diagnostic.code);
}

// Catches: a webapp file importing a form parser that skips the shared limits.
describe("webapp form parser imports", () => {
  it.each([
    'import { parseWithZod } from "@conform-to/zod/v4";',
    'import { parseWithZod } from "@conform-to/zod";',
    'import { parse } from "@conform-to/react";',
    'import { parseSubmission } from "@conform-to/react/future";',
    'import { parse } from "@conform-to/dom";',
  ])("reports %s", (statement) => {
    expect(lint(`${statement}\nexport {};\n`)).toContain("eslint(no-restricted-imports)");
  });

  it.each([
    'import { parseWithZod } from "~/utils/conform";',
    'import { useForm } from "@conform-to/react";',
    'import { getZodConstraint } from "@conform-to/zod/v4";',
  ])("allows %s", (statement) => {
    expect(lint(`${statement}\nexport {};\n`)).toEqual([]);
  });
});
