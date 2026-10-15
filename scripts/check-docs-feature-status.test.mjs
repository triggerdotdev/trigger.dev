import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractEnvKeys,
  extractFeatureFlagKeys,
  extractFeatureStatusTags,
  findProblems,
} from "./check-docs-feature-status.mjs";

const flagKeys = new Set(["queueArchivingEnabled"]);
const envKeys = new Set(["RUN_ENGINE_CONCURRENCY_KEY_LIMITS_ENABLED"]);

function problemsFor(mdx) {
  return findProblems(extractFeatureStatusTags(mdx, "docs/page.mdx"), flagKeys, envKeys);
}

test("known catalog flag passes", () => {
  assert.deepEqual(problemsFor('<RollingOut flag="queueArchivingEnabled" />'), []);
});

test("known env gate passes", () => {
  assert.deepEqual(
    problemsFor('<PrivateBeta flag="env:RUN_ENGINE_CONCURRENCY_KEY_LIMITS_ENABLED" />'),
    []
  );
});

test("typo in flag fails with file, line and value", () => {
  const [problem] = problemsFor('intro\n\n<RollingOut flag="queueArchiveEnabled" />');
  assert.equal(problem.at, "docs/page.mdx:3");
  assert.match(problem.message, /"queueArchiveEnabled"/);
});

test("removed flag fails", () => {
  const problems = findProblems(
    extractFeatureStatusTags('<RollingOut flag="queueArchivingEnabled" />', "docs/page.mdx"),
    new Set(),
    envKeys
  );
  assert.equal(problems.length, 1);
});

test("unknown env var fails", () => {
  assert.equal(problemsFor('<RollingOut flag="env:NOPE_ENABLED" />').length, 1);
});

test("missing flag fails", () => {
  assert.match(problemsFor("<PrivateBeta />")[0].message, /missing flag/);
});

test("multi-line tag is reported, not skipped", () => {
  const problems = problemsFor('<RollingOut\n  flag="queueArchivingEnabled"\n/>');
  assert.match(problems[0].message, /single-line/);
});

test("expression attribute is reported", () => {
  assert.match(problemsFor("<RollingOut flag={FLAG} />")[0].message, /string literals/);
});

test("tags inside code fences and the import line are ignored", () => {
  const mdx = [
    'import { RollingOut } from "/snippets/feature-status.jsx";',
    "```mdx",
    '<RollingOut flag="madeUp" />',
    "```",
  ].join("\n");
  assert.deepEqual(extractFeatureStatusTags(mdx, "docs/page.mdx"), []);
});

test("finds two tags on one line", () => {
  const mdx = '<RollingOut flag="a" /> <PrivateBeta flag="b" />';
  assert.equal(extractFeatureStatusTags(mdx, "docs/page.mdx").length, 2);
});

test("reads FEATURE_FLAG keys and ignores the catalog below it", () => {
  const source = [
    'import { z } from "zod";',
    "export const FEATURE_FLAG = {",
    '  queueArchivingEnabled: "queueArchivingEnabled",',
    "  // a comment",
    '  hasSso: "hasSso",',
    "} as const;",
    "export const OTHER = {",
    '  oldFeature: "oldFeature",',
    "};",
  ].join("\n");
  assert.deepEqual([...extractFeatureFlagKeys(source)], ["queueArchivingEnabled", "hasSso"]);
});

test("reads FEATURE_FLAG keys when the object ends without as const", () => {
  const source = [
    "export const FEATURE_FLAG = {",
    '  hasSso: "hasSso",',
    "};",
    "export const OTHER = {",
    '  oldFeature: "oldFeature",',
    "};",
  ].join("\n");
  assert.deepEqual([...extractFeatureFlagKeys(source)], ["hasSso"]);
});

test("changed catalog format yields no keys", () => {
  assert.equal(extractFeatureFlagKeys("export const FLAGS = { a: 'a' };").size, 0);
});

test("reads env schema keys", () => {
  const source = [
    "const EnvironmentSchema = z.object({",
    '  RUN_ENGINE_CONCURRENCY_KEY_LIMITS_ENABLED: z.string().default("0"),',
    "  API_RATE_LIMIT_METRICS_ENABLED: z",
    "    .string()",
    "});",
  ].join("\n");
  assert.deepEqual(
    [...extractEnvKeys(source)],
    ["RUN_ENGINE_CONCURRENCY_KEY_LIMITS_ENABLED", "API_RATE_LIMIT_METRICS_ENABLED"]
  );
});

test("other components and similar names are ignored", () => {
  const mdx = '<Warning>x</Warning>\n<RollingOutBanner flag="madeUp" />';
  assert.deepEqual(extractFeatureStatusTags(mdx, "docs/page.mdx"), []);
});
