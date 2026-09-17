import type { JsonTestResults } from "vitest/reporters";

type TimingReport = Pick<
  JsonTestResults,
  "success" | "numFailedTests" | "numFailedTestSuites" | "numTotalTests" | "testResults"
>;

/** Refresh only measured internal files; keep other suites and skipped files unchanged. */
export function updateTestTimings(
  previous: Record<string, number>,
  report: TimingReport
): Record<string, number> {
  if (
    report.success !== true ||
    report.numFailedTests !== 0 ||
    report.numFailedTestSuites !== 0 ||
    !(report.numTotalTests > 0) ||
    !Array.isArray(report.testResults) ||
    report.testResults.reduce((sum, file) => sum + file.assertionResults.length, 0) !==
      report.numTotalTests
  ) {
    throw new Error("Timings require a complete, successful internal test report");
  }

  const updated = { ...previous };
  const seen = new Set<string>();
  let measured = 0;
  for (const result of report.testResults) {
    // CI runners have different checkout prefixes. Store only monorepo-relative paths.
    const file = result.name.replaceAll("\\", "/").match(/(?:^|\/)(internal-packages\/.+)$/)?.[1];
    if (!file || file.split("/").some((part) => part === ".." || part === ".")) {
      throw new Error(`Unexpected internal test path: ${result.name}`);
    }
    if (seen.has(file)) {
      throw new Error(`Duplicate test file in shard reports: ${file}`);
    }
    seen.add(file);
    if (
      result.status !== "passed" ||
      result.assertionResults.some((test) => test.status === "failed")
    ) {
      throw new Error(`Cannot record failed test file: ${file}`);
    }
    if (!result.assertionResults.some((test) => test.status === "passed")) continue;
    const duration = result.endTime - result.startTime;
    if (!Number.isFinite(duration) || duration < 0) {
      throw new Error(`Invalid test duration for ${file}`);
    }
    updated[file] = Math.max(1, Math.round(duration));
    measured++;
  }
  if (measured === 0) throw new Error("No internal test timings were measured");
  return updated;
}
