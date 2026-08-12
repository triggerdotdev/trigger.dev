import { describe, expect, it } from "vitest";
import {
  formatTriggerUri,
  isTriggerUri,
  parseTriggerUri,
  safeParseTriggerUri,
  triggerUriSchema,
  type ParsedTriggerUri,
} from "./trigger-uri.js";

const proj = "proj_abc123";
const env = "cm5x9k2h40000abcd";

const roundTrips: Array<[string, ParsedTriggerUri]> = [
  ["run", { kind: "run", projectRef: proj, environmentId: env, runId: "run_abc123" }],
  [
    "span",
    { kind: "span", projectRef: proj, environmentId: env, runId: "run_abc123", spanId: "span_0f1" },
  ],
  ["error", { kind: "error", projectRef: proj, environmentId: env, fingerprint: "a1b2c3d4" }],
  ["queue", { kind: "queue", projectRef: proj, environmentId: env, name: "email-sends" }],
  ["queue with slash", { kind: "queue", projectRef: proj, environmentId: env, name: "team/a/b" }],
  [
    "queue with spaces",
    { kind: "queue", projectRef: proj, environmentId: env, name: "my queue 2" },
  ],
  [
    "queue with percent",
    { kind: "queue", projectRef: proj, environmentId: env, name: "100%-done" },
  ],
  [
    "queue with unicode",
    { kind: "queue", projectRef: proj, environmentId: env, name: "очередь-✨" },
  ],
  [
    "queue with query-ish chars",
    { kind: "queue", projectRef: proj, environmentId: env, name: "a?b=c&d#e" },
  ],
  [
    "fingerprint with special chars",
    {
      kind: "error",
      projectRef: proj,
      environmentId: env,
      fingerprint: "TypeError: cannot read 'x' of undefined @ /app/#1",
    },
  ],
  [
    "deployment",
    { kind: "deployment", projectRef: proj, environmentId: env, version: "20250718.1" },
  ],
  ["report", { kind: "report", projectRef: proj, environmentId: env, key: "health" }],
  ["report with slash key", { kind: "report", projectRef: proj, environmentId: env, key: "a/b" }],
  [
    "source",
    { kind: "source", projectRef: proj, environmentId: env, sha: "deadbeef", path: "src/index.ts" },
  ],
  [
    "source nested with line",
    {
      kind: "source",
      projectRef: proj,
      environmentId: env,
      sha: "deadbeef",
      path: "apps/webapp/app/routes/some route.tsx",
      line: 42,
    },
  ],
  [
    "source path with bracket chars",
    {
      kind: "source",
      projectRef: proj,
      environmentId: env,
      sha: "deadbeef",
      path: "src/we[i/r]d.ts",
      line: 1,
    },
  ],
  [
    "investigation",
    { kind: "investigation", projectRef: proj, environmentId: env, investigationId: "inv_123" },
  ],
  ["runs collection", { kind: "runs", projectRef: proj, environmentId: env }],
];

describe("format/parse round trip", () => {
  for (const [name, parsed] of roundTrips) {
    it(name, () => {
      const uri = formatTriggerUri(parsed);
      expect(parseTriggerUri(uri)).toEqual(parsed);
      expect(isTriggerUri(uri)).toBe(true);
    });
  }
});

describe("canonical shapes", () => {
  it("formats the simple kinds unencoded", () => {
    expect(
      formatTriggerUri({ kind: "run", projectRef: proj, environmentId: env, runId: "run_1" })
    ).toBe(`trigger://${proj}/${env}/run/run_1`);
    expect(
      formatTriggerUri({
        kind: "span",
        projectRef: proj,
        environmentId: env,
        runId: "run_1",
        spanId: "s1",
      })
    ).toBe(`trigger://${proj}/${env}/run/run_1/span/s1`);
  });

  it("keeps source path separators but encodes each segment", () => {
    expect(
      formatTriggerUri({
        kind: "source",
        projectRef: proj,
        environmentId: env,
        sha: "abc",
        path: "src/a b/c.ts",
        line: 7,
      })
    ).toBe(`trigger://${proj}/${env}/source/abc/src/a%20b/c.ts?line=7`);
  });

  it("percent-encodes an arbitrary queue name into one segment", () => {
    expect(
      formatTriggerUri({ kind: "queue", projectRef: proj, environmentId: env, name: "a/b" })
    ).toBe(`trigger://${proj}/${env}/queue/a%2Fb`);
  });

  it("omits line when absent", () => {
    expect(
      formatTriggerUri({
        kind: "source",
        projectRef: proj,
        environmentId: env,
        sha: "abc",
        path: "a.ts",
      })
    ).toBe(`trigger://${proj}/${env}/source/abc/a.ts`);
  });
});

describe("parse rejections", () => {
  const bad: Array<[string, string]> = [
    ["empty string", ""],
    ["wrong scheme", `https://${proj}/${env}/run/run_1`],
    ["scheme without slashes", `trigger:${proj}/${env}/run/run_1`],
    ["no resource", `trigger://${proj}/${env}`],
    ["missing id", `trigger://${proj}/${env}/run`],
    ["unknown resource kind", `trigger://${proj}/${env}/task/my-task`],
    ["empty project segment", `trigger:///${env}/run/run_1`],
    ["empty env segment", `trigger://${proj}//run/run_1`],
    ["empty id segment", `trigger://${proj}/${env}/run/`],
    ["trailing slash", `trigger://${proj}/${env}/queue/a/`],
    ["extra segments on run", `trigger://${proj}/${env}/run/run_1/extra`],
    ["span without a span id", `trigger://${proj}/${env}/run/run_1/span`],
    ["misspelled span keyword", `trigger://${proj}/${env}/run/run_1/spans/s1`],
    ["extra segments on queue", `trigger://${proj}/${env}/queue/a/b`],
    ["source without a path", `trigger://${proj}/${env}/source/abc`],
    ["query on a non-source uri", `trigger://${proj}/${env}/run/run_1?line=2`],
    ["unknown query param", `trigger://${proj}/${env}/source/abc/a.ts?col=2`],
    ["non-numeric line", `trigger://${proj}/${env}/source/abc/a.ts?line=abc`],
    ["zero line", `trigger://${proj}/${env}/source/abc/a.ts?line=0`],
    ["negative line", `trigger://${proj}/${env}/source/abc/a.ts?line=-3`],
    ["fragment", `trigger://${proj}/${env}/run/run_1#top`],
    ["malformed percent-encoding", `trigger://${proj}/${env}/queue/%zz`],
  ];

  for (const [name, input] of bad) {
    it(`rejects ${name}`, () => {
      const result = safeParseTriggerUri(input);
      expect(result.success).toBe(false);
      expect(() => parseTriggerUri(input)).toThrow(/Invalid trigger:\/\/ URI/);
      expect(isTriggerUri(input)).toBe(false);
    });
  }
});

describe("format guards", () => {
  it("refuses to format an empty segment", () => {
    expect(() =>
      formatTriggerUri({ kind: "queue", projectRef: proj, environmentId: env, name: "" })
    ).toThrow(/empty name/);
    expect(() =>
      formatTriggerUri({ kind: "run", projectRef: "", environmentId: env, runId: "run_1" })
    ).toThrow(/empty projectRef/);
  });

  it("refuses a non-positive line", () => {
    expect(() =>
      formatTriggerUri({
        kind: "source",
        projectRef: proj,
        environmentId: env,
        sha: "abc",
        path: "a.ts",
        line: 0,
      })
    ).toThrow(/positive integer/);
  });
});

describe("triggerUriSchema", () => {
  it("accepts a valid uri and brands it", () => {
    const parsed = triggerUriSchema.parse(`trigger://${proj}/${env}/report/health`);
    expect(parsed).toBe(`trigger://${proj}/${env}/report/health`);
  });

  it("rejects a dashboard url", () => {
    expect(triggerUriSchema.safeParse("https://cloud.trigger.dev/runs/run_1").success).toBe(false);
  });
});
