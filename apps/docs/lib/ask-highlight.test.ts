import { describe, expect, test } from "vitest";
import { grammarOf, highlightTokens } from "./ask-highlight";

describe("Ask AI code highlighting", () => {
  test("supported fences become tokens with light and dark styles", async () => {
    const lines = await highlightTokens('const a = "x";\n// done', "ts");
    expect(lines).toHaveLength(2);
    expect(lines![0]!.length).toBeGreaterThan(1);
    expect(Object.keys(lines![0]![0]!.htmlStyle ?? {})).toEqual(
      expect.arrayContaining(["--shiki-light", "--shiki-dark"])
    );
  });

  test("fence aliases map to the docs' grammars; others stay plain", async () => {
    expect(grammarOf("bash")).toBe("shellscript");
    expect(grammarOf("yml")).toBe("yaml");
    expect(grammarOf("tsx")).toBe("tsx");
    expect(await highlightTokens("graph TD", "mermaid")).toBeNull();
  });
});
