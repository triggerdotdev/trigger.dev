import type { ErrorGroupDetail } from "@trigger.dev/core/v3";
import { prisma } from "~/db.server";
import { ApiErrorGroupPresenter } from "~/presenters/v3/ApiErrorGroupPresenter.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import { ErrorGroupActions, errorGroupRevision } from "~/v3/services/errorGroupActions.server";
import type { McpSubject } from "../gate/types";
import type { McpToolContext, McpToolResult } from "../gate/withMcpToolAuth.server";
import type { McpToolDefinition } from "../registry.server";
import { resolveToolEnvironment, textResult } from "./define.server";
import { defineWriteTool, staleAnswer } from "./defineWrite.server";
import { chooseErrorTask, fingerprintOf } from "./errorTask.server";
import {
  type ErrorPreview,
  type StoredGroup,
  comparablePreview,
  errorNotFound,
  ignorePreview,
  resolvePreview,
  unresolvePreview,
  writtenAnswer,
} from "./format/errors";
import { plainError } from "./format/insights";
import { startReadBudget } from "./readBudget.server";
import {
  IgnoreErrorInput,
  ResolveErrorInput,
  ErrorWriteInput,
  type ErrorWriteInput as ErrorWriteArgs,
} from "./schemas/errors";

const auth = {
  action: "write",
  subject: "errors",
  resourceId: (args: { errorId?: string }) => args.errorId,
} as const;

const READ_BUDGET_MS = 20_000;
const STOPPED = {
  aborted: "The request was cancelled before the error group was read; nothing changed.",
  timeout: "Reading the error group took too long; nothing changed. Try again.",
};

type Budget = ReturnType<typeof startReadBudget>;
type Stopped = { stopped: keyof typeof STOPPED };

/** Each read goes through the budget, so none starts once the deadline or cancel has passed. */
async function findGroup(
  scope: { organizationId: string; projectId: string; environmentId: string },
  args: ErrorWriteArgs,
  budget: Budget
): Promise<StoredGroup | { refuse: string } | Stopped> {
  const choice = await budget.read(() =>
    chooseErrorTask(scope, args.errorId, args.taskIdentifier, budget.limit())
  );
  if (!choice.ok) return { stopped: choice.reason };
  if ("notFound" in choice.value) return { refuse: errorNotFound(args.errorId) };
  if ("ambiguous" in choice.value) return { refuse: `${choice.value.ambiguous}; nothing changed.` };
  const task = choice.value.task;
  // One read of the state row on the primary gives the shown state, hasState and the revision,
  // so a preview always describes the version it is bound to and replica lag cannot hide a change.
  const state = await budget.read(() =>
    prisma.errorGroupState.findFirst({
      where: {
        environmentId: scope.environmentId,
        taskIdentifier: task,
        errorFingerprint: fingerprintOf(args.errorId),
      },
      select: {
        status: true,
        resolvedAt: true,
        resolvedInVersion: true,
        resolvedBy: true,
        ignoredAt: true,
        ignoredUntil: true,
        ignoredReason: true,
        ignoredByUserId: true,
        ignoredUntilOccurrenceRate: true,
        ignoredUntilTotalOccurrences: true,
        updatedAt: true,
      },
    })
  );
  if (!state.ok) return { stopped: state.reason };
  const group = await budget.read(() =>
    new ApiErrorGroupPresenter(prisma, prisma).call(
      scope.organizationId,
      scope.projectId,
      scope.environmentId,
      fingerprintOf(args.errorId),
      task,
      { state: state.value }
    )
  );
  if (!group.ok) return { stopped: group.reason };
  if (!group.value) return { refuse: errorNotFound(args.errorId) };
  return {
    group: group.value,
    hasState: state.value !== null,
    revision: errorGroupRevision(state.value),
  };
}

function previewFor<A extends ErrorWriteArgs>(
  plan: (args: A, stored: StoredGroup) => ErrorPreview,
  budgetMs: number
) {
  return async (args: A, subject: McpSubject | null): Promise<ErrorPreview> => {
    if (!subject?.projectId || !subject.environmentId) return { refuse: "Environment not found" };
    // The gate gives a preview no request signal, so only the deadline can stop its reads.
    const budget = startReadBudget(budgetMs, new AbortController().signal);
    const stored = await findGroup(
      {
        organizationId: subject.organizationId,
        projectId: subject.projectId,
        environmentId: subject.environmentId,
      },
      args,
      budget
    );
    if ("stopped" in stored) return { refuse: STOPPED[stored.stopped] };
    return "refuse" in stored ? stored : plan(args, stored);
  };
}

async function planWrite<A extends ErrorWriteArgs>(
  input: A,
  ctx: McpToolContext,
  plan: (args: A, stored: StoredGroup) => ErrorPreview,
  budgetMs: number
): Promise<
  | { error: McpToolResult }
  | { environment: AuthenticatedEnvironment; group: ErrorGroupDetail; revision: string }
> {
  const budget = startReadBudget(budgetMs, ctx.signal);
  const found = await budget.read(() => resolveToolEnvironment(ctx));
  if (!found.ok) return { error: plainError(STOPPED[found.reason]) };
  const environment = found.value;
  if (!environment) return { error: plainError("Environment not found") };
  const stored = await findGroup(
    {
      organizationId: environment.organizationId,
      projectId: environment.projectId,
      environmentId: environment.id,
    },
    input,
    budget
  );
  if ("stopped" in stored) return { error: plainError(STOPPED[stored.stopped]) };
  if ("refuse" in stored) return { error: plainError(stored.refuse) };
  const rebuilt = plan(input, stored);
  if (typeof rebuilt !== "string") return { error: plainError(rebuilt.refuse) };
  if (
    ctx.confirmation &&
    comparablePreview(ctx.confirmation.preview) !== comparablePreview(rebuilt)
  ) {
    return { error: staleAnswer(plainError) };
  }
  return { environment, group: stored.group, revision: stored.revision };
}

/** Runs the write; a group changed since the approved preview answers stale and writes nothing. */
async function written(ctx: McpToolContext, write: () => Promise<unknown>, done: string) {
  try {
    await write();
    return textResult(done);
  } catch (error) {
    if (error instanceof ServiceValidationError && error.status === 409) {
      return ctx.confirmation ? staleAnswer(plainError) : plainError(error.message);
    }
    throw error;
  }
}

const identifierOf = (environment: AuthenticatedEnvironment, group: ErrorGroupDetail) => ({
  organizationId: environment.organizationId,
  projectId: environment.projectId,
  environmentId: environment.id,
  taskIdentifier: group.taskIdentifier,
  errorFingerprint: group.fingerprint,
});

export function createErrorsWriteTools({
  budgetMs = READ_BUDGET_MS,
}: { budgetMs?: number } = {}): McpToolDefinition[] {
  return [
    defineWriteTool({
      name: "resolve_error",
      title: "Resolve Error",
      description:
        "Mark an error group resolved, like Resolve on the Errors page. Optionally record the version the fix ships in. If the error occurs again, the project's error alerts report it as a regression and it becomes unresolved.",
      shape: ResolveErrorInput.shape,
      approval: "configurable",
      auth,
      confirm: { preview: previewFor(resolvePreview, budgetMs) },
      run: async (input, ctx) => {
        const planned = await planWrite(input, ctx, resolvePreview, budgetMs);
        if ("error" in planned) return planned.error;

        return written(
          ctx,
          () =>
            new ErrorGroupActions().resolveError(
              identifierOf(planned.environment, planned.group),
              { userId: ctx.identity.userId, resolvedInVersion: input.resolvedInVersion },
              planned.revision
            ),
          writtenAnswer("Resolved", input.errorId, planned.group.taskIdentifier)
        );
      },
    }),
    defineWriteTool({
      name: "ignore_error",
      title: "Ignore Error",
      description:
        "Ignore an error group, like Ignore on the Errors page, so it sends no error alerts. Optionally stop ignoring after a duration in milliseconds, once it occurs more than a rate per minute, or after a number of further occurrences, whichever comes first; with none it is ignored until changed.",
      shape: IgnoreErrorInput.shape,
      approval: "configurable",
      auth,
      confirm: { preview: previewFor(ignorePreview, budgetMs) },
      run: async (input, ctx) => {
        const planned = await planWrite(input, ctx, ignorePreview, budgetMs);
        if ("error" in planned) return planned.error;

        return written(
          ctx,
          () =>
            new ErrorGroupActions().ignoreError(
              identifierOf(planned.environment, planned.group),
              {
                userId: ctx.identity.userId,
                duration: input.duration,
                occurrenceRateThreshold: input.occurrenceRate,
                totalOccurrencesThreshold: input.totalOccurrences,
                occurrenceCountAtIgnoreTime: input.totalOccurrences
                  ? planned.group.count
                  : undefined,
                reason: input.reason || undefined,
              },
              planned.revision
            ),
          writtenAnswer("Ignored", input.errorId, planned.group.taskIdentifier)
        );
      },
    }),
    defineWriteTool({
      name: "unresolve_error",
      title: "Unresolve Error",
      description:
        "Mark a resolved or ignored error group unresolved again, like Unresolve on the Errors page. This removes its resolution or ignore setting.",
      shape: ErrorWriteInput.shape,
      approval: "configurable",
      auth,
      confirm: { preview: previewFor(unresolvePreview, budgetMs) },
      run: async (input, ctx) => {
        const planned = await planWrite(input, ctx, unresolvePreview, budgetMs);
        if ("error" in planned) return planned.error;

        return written(
          ctx,
          () =>
            new ErrorGroupActions().unresolveError(
              identifierOf(planned.environment, planned.group),
              planned.revision
            ),
          writtenAnswer("Unresolved", input.errorId, planned.group.taskIdentifier)
        );
      },
    }),
  ];
}

export const errorsWriteTools: McpToolDefinition[] = createErrorsWriteTools();
