import { describe, expect, it } from "vitest";
import { buildWatchTools } from "./watch-tools";
import type { DashboardAgentToolContext } from "./tool-context";
import type { ReadScope, ScopedReadKind, SourceReadLookup } from "./tool-source-ledger";

const CTX: DashboardAgentToolContext = {
  projectRef: "proj_here",
  environmentName: "dev",
  environmentId: "env_here",
};

const OTHER: ReadScope = {
  projectRef: "P2",
  environmentId: "env_p2_prod",
  environmentName: "prod",
};

const THIRD: ReadScope = {
  projectRef: "P3",
  environmentId: "env_p3_prod",
  environmentName: "prod",
};

function fakeReads(opts: { runScope?: ReadScope; scoped?: Record<string, ReadScope[]> } = {}) {
  const scoped = opts.scoped ?? {};
  return {
    wasReadThisTurn: () => false,
    shaForReadPath: () => undefined,
    scopesForSourceRead: () => [],
    scopeForRun: (_runId: string) => opts.runScope,
    scopesForScopedRead: (kind: ScopedReadKind, id: string) => scoped[`${kind}:${id}`] ?? [],
  } satisfies SourceReadLookup;
}

const EVERY = { checkEveryMinutes: 5 as const, maxHours: 1, note: "n" };
const QUEUE_WATCH = { kind: "backlog_drain" as const, queue: "email-sends", ...EVERY };

const RUN_WATCH = {
  kind: "run_finished" as const,
  runId: "run_1",
  checkEveryMinutes: 1 as const,
  maxHours: 2,
  note: "tell me when it finishes",
};

function scheduleTool(reads?: SourceReadLookup) {
  const tools = buildWatchTools({ ctx: CTX, reads });
  return tools.schedule_watch as {
    execute: (input: unknown, opts: unknown) => Promise<any>;
  };
}

describe("schedule_watch — conversation-scope guard", () => {
  it("refuses a run read from another project/environment this turn", async () => {
    const reads = fakeReads({ runScope: OTHER });
    const result = await scheduleTool(reads).execute({ watch: RUN_WATCH }, {});

    expect(result.error).toContain("Watches are limited to the current project/environment");
    expect(result.error).toContain("proj_here/dev");
    expect(result.error).toContain("P2/prod");
    expect(result.error).toContain("run_1");
  });

  it("emits the watch intent as before for an object read in the conversation's own env", async () => {
    const own: ReadScope = { projectRef: "proj_here", environmentId: "env_here" };
    const reads = fakeReads({ runScope: own });
    const result = await scheduleTool(reads).execute({ watch: RUN_WATCH }, {});

    expect(result).toEqual({ intent: { kind: "watch", spec: RUN_WATCH } });
  });

  it("refuses a run never read this turn, rather than silently binding it to the current scope", async () => {
    const reads = fakeReads(); // no run read recorded at all
    const result = await scheduleTool(reads).execute({ watch: RUN_WATCH }, {});

    expect(result.error).toContain("hasn't been read this turn");
    expect(result.error).toContain("get_run");
  });

  it("emits the watch intent when no read ledger is available at all", async () => {
    const result = await scheduleTool(undefined).execute({ watch: RUN_WATCH }, {});

    expect(result).toEqual({ intent: { kind: "watch", spec: RUN_WATCH } });
  });

  it.each([
    ["a queue", QUEUE_WATCH, { "queue:email-sends": [OTHER] }],
    [
      "an error recurrence watch",
      { kind: "error_recurrence" as const, fingerprint: "fp_1", ...EVERY },
      { "error:fp_1": [OTHER] },
    ],
    [
      "a health report watch",
      {
        kind: "health_recovery" as const,
        report: "health" as const,
        fromSeverity: "crit" as const,
        ...EVERY,
      },
      { "report:health": [OTHER] },
    ],
    [
      // The ledger keys the fingerprint with "error_" stripped; the spec's own field
      // carries the prefix, and the guard has to normalize before it looks the id up.
      "an error recurrence watch whose fingerprint still carries the error_ prefix",
      { kind: "error_recurrence" as const, fingerprint: "error_fp_1", ...EVERY },
      { "error:fp_1": [OTHER] },
    ],
  ])("refuses %s read from another environment", async (_name, watch, scoped) => {
    const result = await scheduleTool(fakeReads({ scoped })).execute({ watch }, {});

    expect(result.error).toContain("P2/prod");
  });

  it("refuses a queue read from two siblings this turn, never the conversation's own", async () => {
    // Ambiguous, and neither scope is the conversation's own: a citation refuses in
    // this state, and the watch guard has to too, rather than defaulting to "here".
    const reads = fakeReads({ scoped: { "queue:email-sends": [OTHER, THIRD] } });
    const result = await scheduleTool(reads).execute({ watch: QUEUE_WATCH }, {});

    expect(result.error).toContain("more than one project/environment");
    expect(result.error).not.toEqual(
      expect.stringContaining("Watches are limited to the current project/environment")
    );
  });

  it("refuses a queue never read this turn, rather than silently binding it to the current scope", async () => {
    const reads = fakeReads(); // no scoped reads recorded at all
    const result = await scheduleTool(reads).execute({ watch: QUEUE_WATCH }, {});

    expect(result.error).toContain("hasn't been read this turn");
    expect(result.error).toContain("get_queue");
  });

  it("proposes the watch when the queue was read once, in the conversation's own scope", async () => {
    const own: ReadScope = { projectRef: "proj_here", environmentId: "env_here" };
    const reads = fakeReads({ scoped: { "queue:email-sends": [own] } });
    const result = await scheduleTool(reads).execute({ watch: QUEUE_WATCH }, {});

    expect(result).toEqual({ intent: { kind: "watch", spec: QUEUE_WATCH } });
  });

  it("still refuses a queue read once, elsewhere", async () => {
    const reads = fakeReads({ scoped: { "queue:email-sends": [OTHER] } });
    const result = await scheduleTool(reads).execute({ watch: QUEUE_WATCH }, {});

    expect(result.error).toContain("Watches are limited to the current project/environment");
    expect(result.error).toContain("P2/prod");
  });
});
