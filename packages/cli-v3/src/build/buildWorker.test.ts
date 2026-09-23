import { join, posix, sep, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { rewriteOutputPath } from "./buildWorker.js";

describe("rewriteOutputPath", () => {
  it("defaults to the host platform's path semantics", () => {
    const out = join(sep, "tmp", "out");
    expect(rewriteOutputPath(out, join(out, "src", "a b.mjs"))).toBe("/app/src/a b.mjs");
  });

  it("maps a bundled file to its /app path on posix", () => {
    expect(rewriteOutputPath("/tmp/out", "/tmp/out/src/trigger/a.mjs", posix)).toBe(
      "/app/src/trigger/a.mjs"
    );
  });

  it("uses forward slashes and keeps spaces and non-ASCII characters on windows", () => {
    const out = "C:\\Users\\me\\AppData\\Local\\Temp\\trigger-build";
    const file = `${out}\\Documents\\DATEN VORBEREITUNG FÜR AUKTIONEN\\trigger.config.mjs`;

    expect(rewriteOutputPath(out, file, win32)).toBe(
      "/app/Documents/DATEN VORBEREITUNG FÜR AUKTIONEN/trigger.config.mjs"
    );
  });

  it("tolerates mixed separators and drive letter case on windows", () => {
    expect(
      rewriteOutputPath("c:\\Users\\me\\out", "C:/Users/me/out/Trigger Demo/index.mjs", win32)
    ).toBe("/app/Trigger Demo/index.mjs");
  });
});
