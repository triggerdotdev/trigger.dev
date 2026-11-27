import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";

// Catches: a broken link inside an imported snippet passing the link check.
const root = mkdtempSync(path.join(tmpdir(), "check-links-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

it("checks the links inside snippets", async () => {
  const app = path.join(root, "apps/docs");
  for (const dir of ["scripts", "lib"]) mkdirSync(path.join(app, dir), { recursive: true });
  cpSync(new URL("./check-links.mjs", import.meta.url), path.join(app, "scripts/check-links.mjs"));
  for (const f of ["content-files.ts", "snippets.ts", "slug.ts"])
    cpSync(new URL(`../lib/${f}`, import.meta.url), path.join(app, "lib", f));
  const docs = path.join(root, "docs");
  mkdirSync(path.join(docs, "snippets"), { recursive: true });
  writeFileSync(path.join(docs, "docs.json"), JSON.stringify({ redirects: [] }));
  writeFileSync(
    path.join(docs, "intro.mdx"),
    '---\ntitle: Intro\n---\n\nimport Help from "/snippets/help.mdx";\n\n<Help />\n'
  );
  writeFileSync(
    path.join(docs, "snippets/help.mdx"),
    "See [intro](/intro), [missing](/missing-page) and [here](#local).\n"
  );
  const { code, stdout } = await new Promise((resolve) =>
    execFile(process.execPath, [path.join(app, "scripts/check-links.mjs")], (error, stdout) =>
      resolve({ code: error?.code ?? 0, stdout })
    )
  );
  expect(stdout).toContain("BROKEN snippets/help.mdx:1: /missing-page (no such page)");
  expect(stdout).not.toContain("/intro (");
  expect(stdout).not.toContain("#local");
  expect(code).toBe(1);
}, 30_000);
