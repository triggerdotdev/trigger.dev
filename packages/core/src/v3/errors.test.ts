import { describe, expect, test } from "vitest";
import { DuplicateTaskIdsError } from "./errors.js";

describe("DuplicateTaskIdsError", () => {
  test("is an Error with a stable name and the collisions attached", () => {
    const collisions = [{ id: "foo", filePaths: ["src/a.ts", "src/b.ts"] }];
    const error = new DuplicateTaskIdsError(collisions);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DuplicateTaskIdsError");
    expect(error.collisions).toEqual(collisions);
  });

  test("names the id and both files when an id is defined in two files", () => {
    const error = new DuplicateTaskIdsError([{ id: "foo", filePaths: ["src/a.ts", "src/b.ts"] }]);

    expect(error.message).toContain('"foo"');
    expect(error.message).toContain("src/a.ts");
    expect(error.message).toContain("src/b.ts");
  });

  test("collapses identical file paths into a single 'more than once' location", () => {
    const error = new DuplicateTaskIdsError([
      { id: "foo", filePaths: ["src/dupe.ts", "src/dupe.ts"] },
    ]);

    expect(error.message).toContain("more than once in src/dupe.ts");
    // The same path must not be listed twice.
    expect(error.message.match(/src\/dupe\.ts/g)).toHaveLength(1);
  });

  test("lists every collision when multiple ids clash", () => {
    const error = new DuplicateTaskIdsError([
      { id: "foo", filePaths: ["src/a.ts", "src/b.ts"] },
      { id: "bar", filePaths: ["src/c.ts", "src/d.ts"] },
    ]);

    expect(error.message).toContain('"foo"');
    expect(error.message).toContain('"bar"');
  });
});
