import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aiSdkMajors } from "./aiSdkMajors.js";

const readJson = (path: string) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Record<string, any>;

/**
 * The AI SDK majors a peer range admits. Reads the comparator forms the range
 * uses (`^N`, `~N`, `N.x.y`, `>=N … <M`) and refuses anything else, so a range
 * this cannot read fails the test instead of passing it.
 */
function admittedMajors(range: string): number[] {
  return range.split("||").flatMap((set) => {
    let lower: number | undefined;
    let upper: number | undefined;
    let caret = false;
    for (const token of set.trim().split(/\s+/)) {
      const match = /^(\^|~|>=|<)?v?(\d+)(\.[\w.-]+)?$/.exec(token);
      if (!match) throw new Error(`Cannot read "${token}" in the ai peer range "${range}"`);
      const [, op, n] = match;
      if (op === "<") upper = Number(n);
      else {
        lower = Number(n);
        caret = op !== ">=";
      }
    }
    if (lower === undefined) throw new Error(`No lower bound in "${set}"`);
    if (caret) return [lower];
    if (upper === undefined) throw new Error(`Open-ended range "${set}" admits every future major`);
    return Array.from({ length: upper - lower }, (_, i) => lower! + i);
  });
}

describe("AI SDK majors under test", () => {
  const pkg = readJson("../package.json");
  const tested = aiSdkMajors.tested.map(({ major }) => major);
  const untested = aiSdkMajors.untested.map(({ major }) => major);

  // Catches: widening the `ai` peer range to a new major without running the
  // SDK's tests and typecheck against it. Majors have changed how a step's
  // input and response are built without changing the types, and an untested
  // major is how a chat.agent whose step input never grows reached users.
  it("tests every major the ai peer range admits, or says why not", () => {
    for (const major of admittedMajors(pkg.peerDependencies.ai)) {
      expect([...tested, ...untested], `AI SDK ${major}`).toContain(major);
    }
    for (const { major, reason } of aiSdkMajors.untested) {
      expect(reason.trim(), `reason for AI SDK ${major}`).not.toBe("");
      expect(tested).not.toContain(major);
    }
  });

  // Catches: a tested major whose alias points at another major, or at
  // nothing, so its project quietly runs the default `ai` instead.
  it("installs each tested major under the package it names", () => {
    expect(tested).toContain(aiSdkMajors.default);
    for (const { major, package: name } of aiSdkMajors.tested) {
      expect(pkg.devDependencies, name).toHaveProperty([name]);
      const installed = readJson(`../node_modules/${name}/package.json`);
      expect(Number(installed.version.split(".")[0]), name).toBe(major);
    }
    const defaultEntry = aiSdkMajors.tested.find(({ major }) => major === aiSdkMajors.default);
    expect(defaultEntry?.package).toBe("ai");
  });

  // Catches: a known-failure entry that no longer names a real test (renamed
  // or removed, so the list only grows stale), or one for the default major,
  // where nothing would skip it and it would read as covered.
  it("lists known failures only for real tests on a non-default tested major", () => {
    for (const { major, file, test, reason } of aiSdkMajors.knownFailures) {
      const at = `${file} > ${test}`;
      expect(tested, at).toContain(major);
      expect(major, at).not.toBe(aiSdkMajors.default);
      expect(reason.trim(), at).not.toBe("");
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(source, at).toContain(test.split(" > ").at(-1));
    }
  });
});
