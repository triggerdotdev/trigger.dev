import { parsePacket, stringifyIO, timeoutError } from "@trigger.dev/core/v3";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { boundedIn } from "@trigger.dev/database";
import { createHash } from "node:crypto";
import {
  resolveDashboardDateTimeWaitpoint,
  skipDashboardDateTimeWaitpoint,
} from "~/services/dashboardDateTimeWaitpoint.server";
import { prisma } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { runStore } from "~/v3/runStore.server";
import { canonicalJson, PREVIEW_LIMIT } from "../confirm/confirmation.server";
import type { McpToolDefinition } from "../registry.server";
import { resolveToolEnvironment, textResult } from "./define.server";
import { defineWriteTool, staleApproval } from "./defineWrite.server";
import { plainError } from "./format/insights";
import { waitpointMissing } from "./format/waitpoints";
import { formatValue, quote } from "./format/runsEditPreview";
import {
  CompleteWaitpointTokenInput,
  type CompleteWaitpointTokenInput as CompleteArgs,
} from "./schemas/waitpoints";
import {
  defaultWaitpointEngine,
  isStoreWaitpoint,
  logWaitpointToolError,
  type WaitpointEngine,
  type WaitpointScope,
  type WaitpointToolsDeps,
} from "./waitpoints.server";
import { READ_BUDGET_MS, startReadBudget } from "./readBudget.server";

const RUN_ID = /^run_[A-Za-z0-9]{1,64}$/;
const SHOWN_RUNS = 5;
const WAITING_READ_LIMIT = 100;
const WAITING_COUNT_LIMIT = 10_000;
const PREVIEW_ALLOWANCE = 1_024;
const STOPPED = {
  aborted: "The request was cancelled before the waitpoint was read; nothing changed.",
  timeout: "Reading the waitpoint took too long; nothing changed. Try again.",
};

type Plan =
  | { kind: "refuse"; message: string }
  | {
      kind: "ready";
      id: string;
      storeDateTime: boolean;
      data: unknown;
      preview: string;
      waiting: number;
    };

const unchanged = (text: string) => ({
  kind: "refuse" as const,
  message: `${text}; nothing changed.`,
});

function parseOutput(args: CompleteArgs): { data: unknown } | { refuse: string } {
  if (args.action !== "complete") {
    return args.output === undefined
      ? { data: undefined }
      : { refuse: "The output argument is only used with action complete" };
  }
  if (args.output === undefined) return { data: {} };
  try {
    return { data: JSON.parse(args.output) };
  } catch {
    return { refuse: "The output is not valid JSON" };
  }
}

const TOO_LARGE = `The output is too large to approve here: a confirmation shows at most ${PREVIEW_LIMIT.toLocaleString("en-US")} characters. Complete the token from the dashboard or the API`;

function hasUnshownNumber(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value) || Object.is(value, -0);
  if (Array.isArray(value)) return value.some(hasUnshownNumber);
  if (value && typeof value === "object") return Object.values(value).some(hasUnshownNumber);
  return false;
}

async function unfaithfulOutput(data: unknown): Promise<string | undefined> {
  if (hasUnshownNumber(data)) {
    return "The output has a number the run would receive as Infinity, -Infinity or -0, which this confirmation cannot show";
  }
  const packet = await stringifyIO(data);
  if (typeof packet.data !== "string") {
    return "The output has a key the run's serializer refuses, such as __proto__, constructor or prototype";
  }
  if (canonicalJson(await parsePacket(packet)) !== canonicalJson(data)) {
    return "The output would reach the run changed by serialization, so this confirmation cannot show it as received";
  }
  return undefined;
}

function typeMismatch(args: CompleteArgs, type: string): string | undefined {
  const wanted = args.action === "skip" ? "DATETIME" : "MANUAL";
  if (type === wanted) return undefined;
  if (type === "MANUAL") {
    return `Waitpoint ${args.waitpointId} is a token; use action complete or timeout`;
  }
  if (type === "DATETIME") {
    return `Waitpoint ${args.waitpointId} is a wait.for or wait.until; use action skip`;
  }
  return `Waitpoint ${args.waitpointId} waits for a ${type === "RUN" ? "run" : "batch"} to finish and cannot be completed by hand`;
}

/** `names` are the friendly ids of the first runs read; `total` and `digest` cover all of them. */
type Waiting = { names: string[]; total: number; digest: string; foreign: boolean };

/**
 * The runs the completion resumes, read on the primary: the token's blocked runs in Postgres, or
 * the runs that waited on a store token, the closest the store can list. A refusal when the set
 * is too large to read in full, since an approval must cover every run it resumes.
 */
async function waitingRuns(
  engine: WaitpointEngine,
  waitpointId: string,
  storeDateTime: boolean,
  scope: WaitpointScope,
  friendlyId: string
): Promise<Waiting | { refuse: string }> {
  // A store token's history is read in one command, so registrations cannot reorder it mid-read.
  const runIds = storeDateTime
    ? await engine.getStoreWaitpointRelatedRunIdsSnapshot({
        waitpointId,
        ...scope,
        limit: WAITING_READ_LIMIT,
      })
    : (
        await runStore.findManyTaskRunWaitpoints(
          {
            where: { waitpointId },
            select: { taskRunId: true },
            orderBy: { taskRunId: "asc" },
            take: WAITING_COUNT_LIMIT + 1,
          },
          prisma
        )
      ).map((edge) => edge.taskRunId);
  const unique = [...new Set(runIds)].sort();
  // Decided on what was read, before removing repeats: a full read may hide more runs.
  if (storeDateTime ? runIds.length >= WAITING_READ_LIMIT : runIds.length > WAITING_COUNT_LIMIT) {
    const count = storeDateTime
      ? `${WAITING_READ_LIMIT} or more runs have waited on it`
      : `more than ${WAITING_COUNT_LIMIT.toLocaleString("en-US")} runs are waiting on it`;
    return {
      refuse: `Waitpoint ${friendlyId} cannot be approved here: ${count}, too many to list them all. Complete it from the dashboard`,
    };
  }
  const read = unique.slice(0, WAITING_READ_LIMIT);
  const runs =
    read.length === 0
      ? []
      : await runStore.findRuns(
          {
            where: { id: { in: boundedIn(read) } },
            select: { friendlyId: true, runtimeEnvironmentId: true },
          },
          prisma
        );
  const own = runs.filter((run) => run.runtimeEnvironmentId === scope.environmentId);
  return {
    names: own.map((run) => run.friendlyId).sort(),
    total: unique.length,
    digest: createHash("sha256").update(unique.join("\n")).digest("hex").slice(0, 12),
    foreign: !storeDateTime && own.length < runs.length,
  };
}

/** Names a sample, and states the total and a digest of every run, so any change shows. */
function runsLine(waiting: Waiting, storeDateTime: boolean, resume: string): string {
  const { names, total, digest } = waiting;
  if (total === 0) {
    return storeDateTime
      ? `No run has waited on it. Any run waiting on it when it completes resumes: ${resume}`
      : "No run is waiting on it now.";
  }
  const shown = names
    .slice(0, SHOWN_RUNS)
    .map((id) => (RUN_ID.test(id) ? id : quote(id)))
    .join(", ");
  const rest = total - Math.min(names.length, SHOWN_RUNS);
  const named = rest === 0 ? shown : `${shown ? `${shown} and ` : ""}${rest} more (set ${digest})`;
  const count = `${total} run${total === 1 ? "" : "s"}`;
  return storeDateTime
    ? `${count} waited on it, a history that can include runs no longer waiting: ${named}. Any run waiting on it when it completes resumes, including one that starts waiting after this approval: ${resume}`
    : `${count} waiting on it resume${total === 1 ? "s" : ""} now: ${named}. ${resume}`;
}

function buildPreview(
  args: CompleteArgs,
  data: unknown,
  completedAfter: Date | null,
  waiting: Waiting,
  storeDateTime: boolean
): string {
  const header = `complete_waitpoint_token on waitpoint ${args.waitpointId} in ${args.environment}:`;
  const steps =
    args.action === "complete"
      ? [
          `1. Complete waitpoint token ${args.waitpointId}, which is waiting, with this output: ${formatValue(data)}`,
          `2. ${runsLine(waiting, storeDateTime, "wait.forToken returns { ok: true } with this output, and the task code uses it.")}`,
          "3. It cannot be undone: the token stays completed, and a run that waits on it later gets this output at once.",
        ]
      : args.action === "timeout"
        ? [
            `1. Complete waitpoint token ${args.waitpointId}, which is waiting, as timed out, the same as when its timeout passes.`,
            `2. ${runsLine(waiting, storeDateTime, "wait.forToken returns { ok: false } with a timeout error.")}`,
            "3. It cannot be undone: the token stays timed out, and a run that waits on it later gets the timeout error at once.",
          ]
        : [
            `1. Skip waitpoint ${args.waitpointId}, a wait.for or wait.until${completedAfter ? ` set to end at ${completedAfter.toISOString()}` : ""}: it ends now instead.`,
            `2. ${runsLine(waiting, storeDateTime, "the wait returns and the task code continues.")}`,
            "3. It cannot be undone.",
          ];
  return [header, ...steps].join("\n");
}

async function buildPlan(
  engine: WaitpointEngine,
  args: CompleteArgs,
  scope: WaitpointScope
): Promise<Plan> {
  const parsed = parseOutput(args);
  if ("refuse" in parsed) return unchanged(parsed.refuse);

  const id = WaitpointId.toId(args.waitpointId);
  const storeDateTime = await isStoreWaitpoint(engine, id, scope.organizationId);
  const where = { id, projectId: scope.projectId, environmentId: scope.environmentId };
  const select = { id: true, type: true, status: true, outputIsError: true, completedAfter: true };
  // Status and waiting runs come from the primary, so replica lag cannot hide a run that started
  // waiting after approval when the preview is rebuilt.
  const waitpoint = storeDateTime
    ? await resolveDashboardDateTimeWaitpoint({ friendlyId: args.waitpointId, ...scope }, engine)
    : await runStore.findWaitpointOnPrimary({ where, select });
  if (!waitpoint) return unchanged(waitpointMissing(args.waitpointId));

  const mismatch = typeMismatch(args, waitpoint.type);
  if (mismatch) return unchanged(mismatch);
  if (waitpoint.status !== "PENDING") {
    return unchanged(
      `Waitpoint ${args.waitpointId} is already ${waitpoint.outputIsError ? "timed out" : "completed"}`
    );
  }

  const waiting = await waitingRuns(engine, id, storeDateTime, scope, args.waitpointId);
  if ("refuse" in waiting) return unchanged(waiting.refuse);
  if (waiting.foreign) return unchanged(waitpointMissing(args.waitpointId));

  if (args.action === "complete") {
    const unfaithful = await unfaithfulOutput(parsed.data);
    if (unfaithful) return unchanged(unfaithful);
  }
  const preview = buildPreview(args, parsed.data, waitpoint.completedAfter, waiting, storeDateTime);
  if (preview.length > PREVIEW_LIMIT - PREVIEW_ALLOWANCE) return unchanged(TOO_LARGE);
  return { kind: "ready", id, storeDateTime, data: parsed.data, preview, waiting: waiting.total };
}

async function write(
  engine: WaitpointEngine,
  args: CompleteArgs,
  plan: Extract<Plan, { kind: "ready" }>,
  environment: AuthenticatedEnvironment
) {
  const { id, storeDateTime } = plan;
  const organizationId = environment.organizationId;
  const onlyIfPending = storeDateTime ? { onlyIfPending: true } : {};

  if (args.action === "skip") {
    if (storeDateTime) await skipDashboardDateTimeWaitpoint(id, organizationId, engine);
    else await engine.completeWaitpoint({ id, organizationId });
    return { won: true };
  }

  let output: { type: string; value: string; isError: boolean } | undefined;
  if (args.action === "timeout") {
    output = {
      type: "application/json",
      value: JSON.stringify(timeoutError(new Date())),
      isError: true,
    };
  } else {
    const { MAX_INLINE_COMPLETION_OUTPUT_BYTES } = await import("@internal/run-engine");
    const { processWaitpointCompletionPacket } =
      await import("~/runEngine/concerns/waitpointCompletionPacket.server");
    const friendlyId = WaitpointId.toFriendlyId(id);
    const packet = await processWaitpointCompletionPacket(
      await stringifyIO(plan.data),
      environment,
      storeDateTime ? `${friendlyId}/token/${crypto.randomUUID()}` : `${friendlyId}/token`,
      storeDateTime ? MAX_INLINE_COMPLETION_OUTPUT_BYTES : undefined
    );
    output = packet.data
      ? { type: packet.dataType, value: packet.data, isError: false }
      : undefined;
  }

  const result = await engine.completeWaitpoint({ id, ...onlyIfPending, output, organizationId });
  return {
    won:
      (result.output ?? undefined) === output?.value &&
      result.outputIsError === (output?.isError ?? false),
  };
}

const DONE = {
  complete: (id: string) => `Completed waitpoint token ${id} with the output given.`,
  timeout: (id: string) => `Completed waitpoint token ${id} as timed out.`,
  skip: (id: string) => `Skipped waitpoint ${id}.`,
};
const RESUMES = { complete: "with that output", timeout: "with a timeout error", skip: "now" };

/** Who resumes, from the runs the plan read; a store token's history cannot say which still wait. */
function resumed(plan: Extract<Plan, { kind: "ready" }>, action: keyof typeof RESUMES) {
  if (plan.storeDateTime) return `Any run waiting on it resumes ${RESUMES[action]}.`;
  // A count from before the write: a run can start waiting, or stay blocked elsewhere, after it.
  if (plan.waiting === 0) return "No run was waiting on it when this was approved.";
  return `${plan.waiting} run${plan.waiting === 1 ? " was" : "s were"} waiting on it when this was approved.`;
}

export function createWaitpointsWriteTools({
  engine = defaultWaitpointEngine,
  readBudgetMs = READ_BUDGET_MS,
}: WaitpointToolsDeps = {}): McpToolDefinition[] {
  return [
    defineWriteTool({
      name: "complete_waitpoint_token",
      title: "Complete Waitpoint Token",
      description:
        "Complete a waitpoint that a run is waiting on, as the run page in the dashboard does: complete a token with output (JSON the waiting runs receive), complete a token as timed out, or skip a wait.for or wait.until so it ends now. The waiting runs resume at once and it cannot be undone. It refuses a token with more than 10,000 waiting runs, or a store-kept token that 100 or more runs have waited on; complete those from the dashboard. The ID starts with waitpoint_",
      shape: CompleteWaitpointTokenInput.shape,
      approval: "required",
      auth: { action: "write", subject: "waitpoints" },
      confirm: {
        preview: async (args, subject) => {
          if (!subject?.environmentId || !subject.projectId) {
            return { refuse: "Environment not found" };
          }
          const plan = await buildPlan(await engine(), args, {
            organizationId: subject.organizationId,
            projectId: subject.projectId,
            environmentId: subject.environmentId,
          });
          return plan.kind === "ready" ? plan.preview : { refuse: plan.message };
        },
      },
      run: async (input, ctx) => {
        const waitpointEngine = await engine();
        const budget = startReadBudget(readBudgetMs, ctx.signal);
        const resolved = await budget.read(() => resolveToolEnvironment(ctx));
        if (!resolved.ok) return plainError(STOPPED[resolved.reason]);
        const environment = resolved.value;
        if (!environment) return plainError("Environment not found");

        let read;
        try {
          read = await budget.read(() =>
            buildPlan(waitpointEngine, input, {
              organizationId: environment.organizationId,
              projectId: environment.projectId,
              environmentId: environment.id,
            })
          );
        } catch (error) {
          logWaitpointToolError("complete_waitpoint_token", error);
          return plainError("Could not read the waitpoint. Try again later; nothing changed.");
        }
        if (!read.ok) return plainError(STOPPED[read.reason]);
        const plan = read.value;
        if (plan.kind === "refuse") return plainError(plan.message);
        const stale = staleApproval(ctx, plan.preview, plainError);
        if (stale) return stale;
        if (ctx.signal.aborted) {
          return plainError("The request was cancelled before the write; nothing changed.");
        }

        let outcome;
        try {
          outcome = await write(waitpointEngine, input, plan, environment);
        } catch (error) {
          logWaitpointToolError("complete_waitpoint_token", error);
          return plainError(
            `Completing waitpoint ${input.waitpointId} failed. Check its status with get_waitpoint_token before trying again.`
          );
        }
        return textResult(
          outcome.won
            ? `${DONE[input.action](input.waitpointId)} ${resumed(plan, input.action)}`
            : `Waitpoint ${input.waitpointId} was completed by something else first, so the output given was not stored. Runs waiting on it resume with that earlier result.`
        );
      },
    }),
  ];
}

export const waitpointsWriteTools: McpToolDefinition[] = createWaitpointsWriteTools();
