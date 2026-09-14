import { describe, expect, it } from "vitest";
import { linkifyAgentText, stripAgentLinks } from "./linkify-agent-text";
import type { ReadScope, ScopedReadKind, SourceReadLookup } from "./tool-source-ledger";

const HERE: ReadScope = { projectRef: "proj_here", environmentId: "env_here" };
const OTHER: ReadScope = { projectRef: "P2", environmentId: "env_p2_prod" };

type Read = { runs?: string[]; scoped?: Record<string, ReadScope[]> };

/** A minimal lookup, keyed exactly like `tool-source-ledger.ts`'s real one. */
function fakeReads(read: Read = {}): SourceReadLookup {
  const runs = read.runs ?? [];
  const scoped = read.scoped ?? {};
  return {
    wasReadThisTurn: () => false,
    shaForReadPath: () => undefined,
    scopesForSourceRead: () => [],
    scopeForRun: (runId) => (runs.includes(runId) ? HERE : undefined),
    scopesForScopedRead: (kind: ScopedReadKind, id: string) => scoped[`${kind}:${id}`] ?? [],
    identitiesRead: (kind) =>
      kind === "run"
        ? runs
        : Object.keys(scoped)
            .filter((key) => key.startsWith(`${kind}:`))
            .map((key) => key.slice(kind.length + 1)),
    timelineForRun: () => undefined,
  };
}

function linkify(text: string, read: Read = {}): string {
  return linkifyAgentText(text, fakeReads(read), HERE);
}

describe("linkifyAgentText", () => {
  it("links a run it read this turn", () => {
    expect(linkify("run_abc123 failed twice.", { runs: ["run_abc123"] })).toBe(
      "[run_abc123](trigger://proj_here/env_here/run/run_abc123) failed twice."
    );
  });

  it("leaves an id the turn never read as plain text", () => {
    expect(linkify("run_abc123 failed twice.")).toBe("run_abc123 failed twice.");
  });

  it("links an error whether or not the prose keeps the prefix", () => {
    const read = { scoped: { "error:a1b2c3d4": [HERE] } };
    expect(linkify("error_a1b2c3d4 keeps recurring", read)).toBe(
      "[error_a1b2c3d4](trigger://proj_here/env_here/error/a1b2c3d4) keeps recurring"
    );
    expect(linkify("fingerprint a1b2c3d4", read)).toBe(
      "fingerprint [a1b2c3d4](trigger://proj_here/env_here/error/a1b2c3d4)"
    );
  });

  it("links a queue name holding a slash as one segment", () => {
    expect(
      linkify("task/worker-1 is backed up", { scoped: { "queue:task/worker-1": [HERE] } })
    ).toBe("[task/worker-1](trigger://proj_here/env_here/queue/task%2Fworker-1) is backed up");
  });

  it("links a deployment version", () => {
    expect(linkify("Broke in 20250101.3.", { scoped: { "deployment:20250101.3": [HERE] } })).toBe(
      "Broke in [20250101.3](trigger://proj_here/env_here/deployment/20250101.3)."
    );
  });

  it("does not match an id that is only part of a longer word", () => {
    expect(linkify("worker-1 and worker-12", { scoped: { "queue:worker-1": [HERE] } })).toBe(
      "[worker-1](trigger://proj_here/env_here/queue/worker-1) and worker-12"
    );
  });

  it("leaves a queue named like an ordinary word unlinked until the sentence says what it is", () => {
    const read = { scoped: { "queue:default": [HERE] } };
    expect(linkify("this is the default behaviour", read)).toBe("this is the default behaviour");
    expect(linkify("queue default is backed up", read)).toBe(
      "queue [default](trigger://proj_here/env_here/queue/default) is backed up"
    );
  });

  it("links a name that carries its own punctuation without being told what it is", () => {
    expect(linkify("task/uat-plain is idle", { scoped: { "queue:task/uat-plain": [HERE] } })).toBe(
      "[task/uat-plain](trigger://proj_here/env_here/queue/task%2Fuat-plain) is idle"
    );
  });

  it("escapes a name that would otherwise read as markup, and the label survives stripping", () => {
    const name = "sends (eu) [x] *z*";
    const linked = linkify(`${name} is backed up`, { scoped: { [`queue:${name}`]: [HERE] } });
    expect(linked).toBe(
      "[sends (eu) \\[x\\] \\*z\\*]" +
        "(trigger://proj_here/env_here/queue/sends%20%28eu%29%20%5Bx%5D%20*z*) is backed up"
    );
    expect(stripAgentLinks(linked)).toBe(`${name} is backed up`);
  });

  // The code span wins: a backtick opens one, and protected text is never rewritten.
  it("leaves a name holding a backtick plain", () => {
    const name = "sends `eu`";
    expect(linkify(`${name} is backed up`, { scoped: { [`queue:${name}`]: [HERE] } })).toBe(
      `${name} is backed up`
    );
  });

  it("keeps a run label readable rather than escaping its underscore", () => {
    expect(stripAgentLinks(linkify("run_abc123 failed", { runs: ["run_abc123"] }))).toBe(
      "run_abc123 failed"
    );
  });

  it("leaves code spans and fenced blocks alone", () => {
    const read = { runs: ["run_abc"] };
    expect(linkify("see `run_abc` here", read)).toBe("see `run_abc` here");
    expect(linkify("```\nrun_abc\n```", read)).toBe("```\nrun_abc\n```");
  });

  it("never double-links text already inside a markdown link", () => {
    const read = { runs: ["run_abc"] };
    const already = "[run_abc](trigger://proj_here/env_here/run/run_abc)";
    expect(linkify(already, read)).toBe(already);
    expect(linkify("[the run](trigger://proj_here/env_here/run/run_abc)", read)).toBe(
      "[the run](trigger://proj_here/env_here/run/run_abc)"
    );
  });

  it("keeps a name read from two other environments plain rather than guessing one", () => {
    expect(
      linkify("email-sends is backed up", {
        scoped: { "queue:email-sends": [OTHER, { projectRef: "P3", environmentId: "env_p3" }] },
      })
    ).toBe("email-sends is backed up");
  });

  it("links a name read only from a sibling environment against that environment", () => {
    expect(linkify("email-sends is backed up", { scoped: { "queue:email-sends": [OTHER] } })).toBe(
      "[email-sends](trigger://P2/env_p2_prod/queue/email-sends) is backed up"
    );
  });
});
