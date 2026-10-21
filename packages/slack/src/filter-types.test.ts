import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * slack()'s `filter` and `startOn` are checked against the endpoint's event type, and an invalid one
 * shows the validator's `✖ ...` message. These compile a consumer file with tsc and assert the
 * diagnostic text at each call, since `@ts-expect-error` passes on any error.
 */

const packageRoot = resolve(__dirname, "..");
const repoRoot = resolve(packageRoot, "../..");

const HEADER = `
import { webhooks } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { mentions, slack, webhookSource, type SlackRunSurface } from "../src/index.js";

const endpoint = webhooks.endpoint.define({ id: "slack-types", source: webhookSource() });
const token = "xoxb-test";
`;

const CASES: Array<{ name: string; code: string; message?: string }> = [
  {
    name: "filter with an unknown field",
    code: `slack({ startOn: "event.event.type == 'message'", id: "a", endpoint, token, filter: "event.event.nope == 'x'" });`,
    message: "✖ unknown field: event.event.nope",
  },
  {
    name: "filter with unbalanced parens",
    code: `slack({ startOn: "event.event.type == 'message'", id: "b", endpoint, token, filter: "( event.event.channel == 'C1'" });`,
    message: '✖ unbalanced parens (missing \\")\\")',
  },
  {
    name: "startOn with an unknown field",
    code: `slack({ id: "c", endpoint, token, startOn: "event.event.txt contains 'deploy'" });`,
    message: "✖ unknown field: event.event.txt",
  },
  {
    name: "valid filters compile",
    code: `slack({ id: "d", endpoint, token, filter: "event.event.channel == 'C1' && event.team_id == 'T1'", startOn: "event.event.text contains '<@U012BOT>'" });`,
  },
  {
    name: "mentions() and filters built at runtime compile",
    code: `const channels: string = ["C1", "C2"].map((c) => \`event.event.channel == '\${c}'\`).join(" || "); slack({ id: "e", endpoint, token, filter: channels, startOn: mentions("U012BOT") });`,
  },
  {
    name: "omitted filter compiles",
    code: `slack({ startOn: "event.event.type == 'message'", id: "f", endpoint, token });`,
  },
  {
    name: "chat.surface<SlackRunSurface>() types the Slack helpers",
    code: `void (async () => { const surface = chat.surface<SlackRunSurface>(); await surface?.post({ text: "hi" }); await surface?.react("eyes"); })();`,
  },
  {
    name: "startOn is required",
    code: `slack({ id: "g", endpoint, token });`,
    message: "startOn",
  },
];

function diagnosticsByLine(): Map<number, string[]> {
  const dir = mkdtempSync(join(packageRoot, ".filter-types-"));
  try {
    writeFileSync(join(dir, "consumer.ts"), `${HEADER}\n${CASES.map((c) => c.code).join("\n")}\n`);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: join(packageRoot, "tsconfig.src.json"),
        compilerOptions: { noEmit: true, composite: false, incremental: false, rootDir: repoRoot },
        include: ["consumer.ts"],
        exclude: [],
      })
    );
    const result = spawnSync(
      join(repoRoot, "node_modules/.bin/tsc"),
      ["-p", dir, "--pretty", "false"],
      { encoding: "utf8" }
    );
    const byLine = new Map<number, string[]>();
    let last: number | undefined;
    for (const line of `${result.stdout}${result.stderr}`.split("\n")) {
      const match = /^(.*?)\((\d+),\d+\): error TS\d+: (.*)$/.exec(line);
      if (match) {
        last = match[1]!.endsWith("consumer.ts") ? Number(match[2]) - 1 : -1;
        byLine.set(last, [...(byLine.get(last) ?? []), match[3]!]);
      } else if (last !== undefined && line.startsWith(" ")) {
        byLine.get(last)!.push(line.trim());
      }
    }
    return byLine;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("slack() filter types", () => {
  const headerLines = `${HEADER}\n`.split("\n").length - 1;
  let byLine: Map<number, string[]>;
  const at = (index: number) => byLine.get(headerLines + index) ?? [];

  it("compiles the consumer file", () => {
    byLine = diagnosticsByLine();
    const outside = [...byLine.entries()].filter(
      ([line]) => line < headerLines || line >= headerLines + CASES.length
    );
    expect(outside).toEqual([]);
  }, 120_000);

  for (const [index, testCase] of CASES.entries()) {
    it(testCase.name, () => {
      if (testCase.message) {
        expect(at(index).join("\n")).toContain(testCase.message);
      } else {
        expect(at(index)).toEqual([]);
      }
    });
  }
});
