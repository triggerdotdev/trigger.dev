import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootPackageJson = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../package.json"), "utf8")
) as {
  pnpm: { overrides: Record<string, string> };
};

describe("fast-xml-parser aws sdk compatibility", () => {
  it("pins 5.x past the 5.7 window that rejects addEntity('#xD')", () => {
    expect(rootPackageJson.pnpm.overrides["fast-xml-parser@>=5 <5.8.0"]).toBe("^5.8.0");
  });

  it("accepts the character-reference entities @aws-sdk/xml-builder registers", async () => {
    const { XMLParser } = await import("fast-xml-parser");
    const parser = new XMLParser({ htmlEntities: true });

    expect(() => {
      parser.addEntity("#xD", "\r");
      parser.addEntity("#10", "\n");
      parser.parse("<a>1</a>", true);
    }).not.toThrow();
  });
});
