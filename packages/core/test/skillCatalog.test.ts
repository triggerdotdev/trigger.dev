import { describe, expect, it, vi } from "vitest";
import { StandardResourceCatalog } from "../src/v3/resource-catalog/standardResourceCatalog.js";

describe("StandardResourceCatalog — skills", () => {
  it("registers and lists a skill manifest", () => {
    const catalog = new StandardResourceCatalog();
    catalog.setCurrentFileContext("trigger/chat.ts", "chat");

    catalog.registerSkillMetadata({ id: "pdf-processing", sourcePath: "./skills/pdf-processing" });

    const manifests = catalog.listSkillManifests();
    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toMatchObject({
      id: "pdf-processing",
      sourcePath: "./skills/pdf-processing",
      filePath: "trigger/chat.ts",
      entryPoint: "chat",
    });
  });

  it("getSkillManifest returns the registered skill", () => {
    const catalog = new StandardResourceCatalog();
    catalog.setCurrentFileContext("trigger/chat.ts", "chat");
    catalog.registerSkillMetadata({ id: "a", sourcePath: "./skills/a" });

    expect(catalog.getSkillManifest("a")?.sourcePath).toBe("./skills/a");
    expect(catalog.getSkillManifest("missing")).toBeUndefined();
  });

  it("skips registration without a file context", () => {
    const catalog = new StandardResourceCatalog();

    catalog.registerSkillMetadata({ id: "pdf", sourcePath: "./skills/pdf" });

    expect(catalog.listSkillManifests()).toHaveLength(0);
  });

  it("warns and ignores when the same id is registered with a different path", () => {
    const catalog = new StandardResourceCatalog();
    catalog.setCurrentFileContext("trigger/chat.ts", "chat");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    catalog.registerSkillMetadata({ id: "pdf", sourcePath: "./skills/pdf" });
    catalog.registerSkillMetadata({ id: "pdf", sourcePath: "./skills/other-pdf" });

    const manifests = catalog.listSkillManifests();
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.sourcePath).toBe("./skills/pdf");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("defined twice"));

    warn.mockRestore();
  });

  it("re-registering the same id + path is idempotent", () => {
    const catalog = new StandardResourceCatalog();
    catalog.setCurrentFileContext("trigger/chat.ts", "chat");

    catalog.registerSkillMetadata({ id: "pdf", sourcePath: "./skills/pdf" });
    catalog.registerSkillMetadata({ id: "pdf", sourcePath: "./skills/pdf" });

    expect(catalog.listSkillManifests()).toHaveLength(1);
  });

  it("registers multiple distinct skills", () => {
    const catalog = new StandardResourceCatalog();
    catalog.setCurrentFileContext("trigger/chat.ts", "chat");

    catalog.registerSkillMetadata({ id: "pdf", sourcePath: "./skills/pdf" });
    catalog.registerSkillMetadata({ id: "researcher", sourcePath: "./skills/researcher" });

    expect(catalog.listSkillManifests().map((s) => s.id).sort()).toEqual(["pdf", "researcher"]);
  });
});
