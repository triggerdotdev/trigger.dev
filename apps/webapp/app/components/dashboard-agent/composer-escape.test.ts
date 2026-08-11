import { describe, expect, it } from "vitest";
import { composerKeepsEscape } from "./composer-escape";

describe("Escape while the composer has focus", () => {
  it("is kept by the composer while there is a draft, so the panel stays open", () => {
    expect(composerKeepsEscape("half a question about a failing run")).toBe(true);
  });

  it("closes the panel when there is nothing to lose", () => {
    expect(composerKeepsEscape("")).toBe(false);
  });

  it("reads whitespace as nothing to lose, matching what Send accepts", () => {
    expect(composerKeepsEscape("  \n ")).toBe(false);
  });
});
