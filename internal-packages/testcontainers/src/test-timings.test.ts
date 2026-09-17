import { describe, expect, test } from "vitest";
import type { JsonTestResult } from "vitest/reporters";
import { updateTestTimings } from "./test-timings.js";

const file = "internal-packages/example/src/example.test.ts";
function result(name = `/home/runner/work/repo/repo/${file}`): JsonTestResult {
  return {
    name,
    status: "passed",
    startTime: 1000,
    endTime: 1250,
    message: "",
    assertionResults: [
      {
        ancestorTitles: [],
        fullName: "example",
        title: "example",
        status: "passed",
        failureMessages: [],
        meta: {},
        tags: [],
      },
    ],
  };
}
function report(...results: JsonTestResult[]) {
  return {
    success: true,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    numTotalTests: results.reduce((sum, file) => sum + file.assertionResults.length, 0),
    testResults: results,
  };
}

describe("weekly internal test timings", () => {
  test("normalizes runner paths and preserves unmeasured and non-internal files", () => {
    const previous = { [file]: 500, "apps/webapp/other.test.ts": 800, "old.test.ts": 30 };
    const next = updateTestTimings(previous, report(result()));
    expect(next).toEqual({ ...previous, [file]: 250 });
    expect(previous[file]).toBe(500);
    expect(
      updateTestTimings({}, report(result(`D:\\runner\\${file.replaceAll("/", "\\")}`)))
    ).toEqual({
      [file]: 250,
    });
  });

  test("keeps timings for skipped files and records a positive duration for fast tests", () => {
    const skipped = result("internal-packages/example/skipped.test.ts");
    skipped.assertionResults[0]!.status = "pending";
    const fast = result();
    fast.endTime = fast.startTime;
    expect(updateTestTimings({ [skipped.name]: 900 }, report(skipped, fast))).toEqual({
      [skipped.name]: 900,
      [file]: 1,
    });
  });

  test("rejects failed, empty and truncated reports without changing stored timings", () => {
    const previous = { [file]: 500 };
    for (const invalid of [
      report(),
      { ...report(result()), success: false },
      { ...report(result()), numFailedTests: 1 },
      { ...report(result()), numFailedTestSuites: 1 },
      { ...report(result()), numTotalTests: 2 },
    ]) {
      expect(() => updateTestTimings(previous, invalid)).toThrow(/complete, successful/);
    }
    expect(previous).toEqual({ [file]: 500 });
  });

  test("rejects overlapping shards even with different runner checkout paths", () => {
    expect(() => updateTestTimings({}, report(result(), result(`/other/runner/${file}`)))).toThrow(
      /Duplicate test file/
    );
  });

  test.each(["apps/webapp/example.test.ts", "internal-packages/../example.test.ts"])(
    "rejects unexpected path %s",
    (path) => expect(() => updateTestTimings({}, report(result(path)))).toThrow(/Unexpected/)
  );

  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid duration %s",
    (duration) => {
      const invalid = result();
      invalid.endTime = invalid.startTime + duration;
      expect(() => updateTestTimings({}, report(invalid))).toThrow(/Invalid test duration/);
    }
  );

  test("rejects failed files and reports containing only skipped tests", () => {
    const invalid = result();
    invalid.status = "failed";
    expect(() => updateTestTimings({}, report(invalid))).toThrow(/failed test file/);
    invalid.status = "passed";
    invalid.assertionResults[0]!.status = "pending";
    expect(() => updateTestTimings({}, report(invalid))).toThrow(/No internal test timings/);
  });
});
