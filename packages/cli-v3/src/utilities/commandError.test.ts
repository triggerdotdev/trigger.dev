import { describe, expect, it } from "vitest";
import { formatCommandError } from "./commandError.js";

const expectedMessage = `Your installed Zod version is not supported by Trigger.dev.

Trigger.dev requires zod@^3.25.56 or zod@^4.0.0. Upgrade Zod, reinstall your dependencies, and try again.`;

describe("formatCommandError", () => {
  it("explains when the installed Zod package does not export zod/v4", () => {
    const error = Object.assign(
      new Error(
        `Package subpath './v4' is not defined by "exports" in /app/node_modules/zod/package.json`
      ),
      { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }
    );

    expect(formatCommandError(error)).toBe(expectedMessage);
  });

  it("explains the broken Zod 3.25.0 package layout", () => {
    const error = Object.assign(
      new Error(`Cannot find module '/app/node_modules/zod/dist/esm/v4/index.js'`),
      { code: "ERR_MODULE_NOT_FOUND" }
    );

    expect(formatCommandError(error)).toBe(expectedMessage);
  });

  it("recognizes wrapped Zod resolution errors", () => {
    const cause = Object.assign(
      new Error(
        `Package subpath './v4/core' is not defined by "exports" in C:\\app\\node_modules\\zod\\package.json`
      ),
      { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }
    );

    expect(formatCommandError(new Error("Failed to load config", { cause }))).toBe(expectedMessage);
  });

  it("preserves unrelated errors", () => {
    const error = Object.assign(
      new Error(
        `Package subpath './v4' is not defined by "exports" in /app/node_modules/other/package.json`
      ),
      { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }
    );

    expect(formatCommandError(error)).toBe(error.message);
    expect(formatCommandError("plain failure")).toBe("plain failure");
  });
});
