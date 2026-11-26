import { expect, it } from "vitest";
import { hasSignedInHint } from "./reader";

// Catches: every anonymous docs view asking the dashboard who is reading.
it("asks the dashboard only when its signed-in hint is set", () => {
  expect(hasSignedInHint("")).toBe(false);
  expect(hasSignedInHint("ph_session=x; theme=dark")).toBe(false);
  expect(hasSignedInHint("docs_signed_in=")).toBe(false);
  expect(hasSignedInHint("not_docs_signed_in=1")).toBe(false);
  expect(hasSignedInHint("docs_signed_in=1")).toBe(true);
  expect(hasSignedInHint("theme=dark; docs_signed_in=1; ph=1")).toBe(true);
});
