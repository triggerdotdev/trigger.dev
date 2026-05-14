import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { defineSkill, parseFrontmatter } from "../src/v3/skill.js";

describe("parseFrontmatter", () => {
  it("parses name + description", () => {
    const { frontmatter, body } = parseFrontmatter(
      `---\nname: pdf-processing\ndescription: Extract text from PDFs.\n---\n\n# Body\n\nhello\n`
    );
    expect(frontmatter.name).toBe("pdf-processing");
    expect(frontmatter.description).toBe("Extract text from PDFs.");
    expect(body).toBe("# Body\n\nhello\n");
  });

  it("strips surrounding quotes", () => {
    const { frontmatter } = parseFrontmatter(
      `---\nname: "quoted-name"\ndescription: 'single quoted'\n---\nbody\n`
    );
    expect(frontmatter.name).toBe("quoted-name");
    expect(frontmatter.description).toBe("single quoted");
  });

  it("throws on missing frontmatter block", () => {
    expect(() => parseFrontmatter("# just a heading\n")).toThrow(/missing a frontmatter block/);
  });

  it("throws on missing required name", () => {
    expect(() => parseFrontmatter(`---\ndescription: desc\n---\nbody`)).toThrow(
      /missing required `name`/
    );
  });

  it("throws on missing required description", () => {
    expect(() => parseFrontmatter(`---\nname: foo\n---\nbody`)).toThrow(
      /missing required `description`/
    );
  });
});

describe("defineSkill.local()", () => {
  const originalCwd = process.cwd();
  let workdir: string;

  beforeEach(async () => {
    workdir = await realpath(await mkdtemp(path.join(tmpdir(), "skill-test-")));
    process.chdir(workdir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(workdir, { recursive: true, force: true });
  });

  it("reads a bundled SKILL.md and returns a ResolvedSkill", async () => {
    const skillDir = path.join(workdir, ".trigger", "skills", "pdf");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: pdf\ndescription: Extract PDF text.\n---\n\n# PDF skill\n\nUse scripts/extract.py.\n`
    );

    const skill = defineSkill({ id: "pdf", path: "./skills/pdf" });
    const resolved = await skill.local();

    expect(resolved.id).toBe("pdf");
    expect(resolved.version).toBe("local");
    expect(resolved.labels).toEqual([]);
    expect(resolved.frontmatter.name).toBe("pdf");
    expect(resolved.frontmatter.description).toBe("Extract PDF text.");
    expect(resolved.body).toContain("# PDF skill");
    expect(resolved.body).toContain("Use scripts/extract.py");
    expect(resolved.path).toBe(skillDir);
  });

  it("throws a useful error when SKILL.md is missing", async () => {
    const skill = defineSkill({ id: "missing", path: "./skills/missing" });
    await expect(skill.local()).rejects.toThrow(/could not read SKILL.md/);
  });

  it("resolve() throws with a helpful Phase 1 message", async () => {
    const skill = defineSkill({ id: "phase-2", path: "./skills/phase-2" });
    await expect(skill.resolve()).rejects.toThrow(/not available yet.*Phase 2.*local/s);
  });
});
