import { describe, expect, it } from "vitest";
import { plainText } from "./plain-text";

describe("plainText", () => {
  // Catches: meta descriptions showing markdown that live strips.
  it("strips inline markdown to its text", () => {
    expect(plainText("The `trigger.dev dev` command")).toBe("The trigger.dev dev command");
    expect(plainText("See [the guide](/guides/x) and **bold** or *em* or _em_")).toBe(
      "See the guide and bold or em or em"
    );
    expect(plainText("Keep snake_case_names and 2 * 3")).toBe("Keep snake_case_names and 2 * 3");
  });
});
