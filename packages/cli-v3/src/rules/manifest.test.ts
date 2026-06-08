import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundledSkillsLoader, loadRulesManifest } from "./manifest.js";

async function makeSkillsDir(opts: { withSkill: boolean }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bundled-skills-"));
  const skillsDir = join(root, "skills");
  await mkdir(skillsDir, { recursive: true });

  if (opts.withSkill) {
    const skillDir = join(skillsDir, "authoring-chat-agent");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: authoring-chat-agent",
        "description: >",
        "  Author a durable AI chat agent with chat.agent. Load when building a chat",
        "  backend or its frontend transport.",
        "type: core",
        'library_version: "{{TRIGGER_SDK_VERSION}}"',
        "---",
        "",
        "# Authoring",
        "",
        "Generated for @trigger.dev/sdk {{TRIGGER_SDK_VERSION}}.",
        "",
      ].join("\n")
    );
  }

  return skillsDir;
}

describe("BundledSkillsLoader", () => {
  const dirs: string[] = [];

  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it("synthesizes a manifest at the given version and stamps it into contents", async () => {
    const skillsDir = await makeSkillsDir({ withSkill: true });
    dirs.push(skillsDir);

    const loader = new BundledSkillsLoader(skillsDir, "9.9.9-test.1");
    const manifest = await loadRulesManifest(loader);

    expect(manifest.currentVersion).toBe("9.9.9-test.1");

    const version = await manifest.getCurrentVersion();
    expect(version.options).toHaveLength(1);

    const option = version.options[0]!;
    expect(option.name).toBe("authoring-chat-agent");
    expect(option.installStrategy).toBe("skills");
    // description extracted from the folded scalar, used as the picker label
    expect(option.label).toContain("Author a durable AI chat agent");
    // version stamped into the copied content; placeholder fully substituted
    expect(option.contents).toContain("9.9.9-test.1");
    expect(option.contents).not.toContain("{{TRIGGER_SDK_VERSION}}");
  });

  it("throws when the skills dir has no skills (caller treats as 'nothing to install')", async () => {
    const skillsDir = await makeSkillsDir({ withSkill: false });
    dirs.push(skillsDir);

    const loader = new BundledSkillsLoader(skillsDir, "9.9.9-test.1");

    await expect(loadRulesManifest(loader)).rejects.toThrow();
  });

  it("throws when the skills dir does not exist", async () => {
    const loader = new BundledSkillsLoader(join(tmpdir(), "does-not-exist-skills-xyz"), "1.2.3");

    await expect(loadRulesManifest(loader)).rejects.toThrow();
  });
});
