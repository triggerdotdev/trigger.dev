import type { RunEngine } from "@internal/run-engine";
import { parsePacket, type WaitpointTokenStatus } from "@trigger.dev/core/v3";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { boundedIn } from "@trigger.dev/database";
import {
  isStoreDateTimeWaitpoint,
  resolveDashboardWaitpointRelatedRuns,
} from "~/services/dashboardDateTimeWaitpoint.server";
import { ApiWaitpointPresenter } from "~/presenters/v3/ApiWaitpointPresenter.server";
import { WaitpointListPresenter } from "~/presenters/v3/WaitpointListPresenter.server";
import { logger } from "~/services/logger.server";
import { runStore } from "~/v3/runStore.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, resolveToolEnvironment, textResult } from "./define.server";
import {
  type ConnectedRun,
  renderTokenDetail,
  renderTokenRow,
  renderWaitpointCursor,
  waitpointNotFound,
} from "./format/waitpoints";
import { plainError } from "./format/insights";
import { formatValue } from "./format/runsEditPreview";
import { READ_BUDGET_MS, startReadBudget, stoppedText } from "./readBudget.server";
import { GetWaitpointTokenInput, ListWaitpointTokensInput } from "./schemas/waitpoints";

export type WaitpointEngine = Pick<
  RunEngine,
  | "completeWaitpoint"
  | "getStoreDateTimeWaitpoint"
  | "getStoreWaitpointRelatedRunIds"
  | "getStoreWaitpointRelatedRunIdsSnapshot"
  | "listStoreManualWaitpoints"
  | "canReadStoreManualWaitpoints"
> & { waitpointSystem: Pick<RunEngine["waitpointSystem"], "isWaitpointStoreEnabled"> };

export type WaitpointToolsDeps = {
  engine?: () => Promise<WaitpointEngine>;
  readBudgetMs?: number;
};

export const defaultWaitpointEngine = async (): Promise<WaitpointEngine> =>
  (await import("~/v3/runEngine.server")).engine;

const WAITPOINT_READ_FAILED = "Could not read the waitpoint. Try again later.";

const auth = { action: "read", subject: "waitpoints" } as const;

export function logWaitpointToolError(tool: string, error: unknown) {
  logger.error("MCP waitpoint tool failed", {
    tool,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
}

export type WaitpointScope = { organizationId: string; projectId: string; environmentId: string };

export async function isStoreWaitpoint(
  engine: WaitpointEngine,
  waitpointId: string,
  organizationId: string
) {
  return (
    (await engine.waitpointSystem.isWaitpointStoreEnabled(organizationId)) &&
    isStoreDateTimeWaitpoint(waitpointId)
  );
}

async function connectedRuns(
  engine: WaitpointEngine,
  waitpointId: string,
  storeDateTime: boolean,
  scope: WaitpointScope,
  withRuns: boolean
): Promise<{ runs: ConnectedRun[]; foreign: boolean }> {
  // Without read:runs only what the environment check needs is read.
  const select = withRuns
    ? { friendlyId: true, runtimeEnvironmentId: true, taskIdentifier: true, status: true }
    : { friendlyId: true, runtimeEnvironmentId: true };
  const ids = storeDateTime
    ? await resolveDashboardWaitpointRelatedRuns({ waitpointId, ...scope }, engine, runStore)
    : await runStore.findWaitpointConnectedRunIds(waitpointId);
  const found: Array<ConnectedRun & { runtimeEnvironmentId: string }> =
    ids.length === 0
      ? []
      : await runStore.findRuns({
          where: storeDateTime
            ? { friendlyId: { in: boundedIn(ids) }, runtimeEnvironmentId: scope.environmentId }
            : { id: { in: boundedIn(ids) } },
          select,
        });
  const runs = found
    .filter((run) => run.runtimeEnvironmentId === scope.environmentId)
    .map(({ runtimeEnvironmentId: _env, ...run }) => run)
    .sort((a, b) => (a.friendlyId < b.friendlyId ? -1 : a.friendlyId > b.friendlyId ? 1 : 0));
  return { runs, foreign: runs.length < found.length };
}

/** The value a waiting run receives, as the preview shows it, not the stored transport packet. */
async function shownOutput(output: string | null | undefined, outputType: string | null) {
  if (output === undefined || output === null || outputType === "application/store") return output;
  try {
    return formatValue(
      await parsePacket({ data: output, dataType: outputType ?? "application/json" })
    );
  } catch {
    return output;
  }
}

const WAITING_AND_TIMED_OUT =
  "WAITING and TIMED_OUT tokens cannot be listed together. Call list_waitpoint_tokens once per status.";

/** The presenter filter for the statuses asked for, or undefined when they cannot be listed together. */
function statusFilter(
  statuses: WaitpointTokenStatus[] | undefined
): { statuses?: WaitpointTokenStatus[]; outputIsError?: boolean } | undefined {
  const wanted = new Set(statuses);
  if (wanted.has("WAITING") && wanted.has("TIMED_OUT") && !wanted.has("COMPLETED"))
    return undefined;
  // Waiting tokens have no error output, so this keeps them and drops timed-out ones.
  if (wanted.size === 2 && wanted.has("WAITING") && wanted.has("COMPLETED")) {
    return { statuses: [...wanted], outputIsError: false };
  }
  return { statuses: wanted.size ? [...wanted] : undefined };
}

export function createWaitpointsTools({
  engine = defaultWaitpointEngine,
  readBudgetMs = READ_BUDGET_MS,
}: WaitpointToolsDeps = {}): McpToolDefinition[] {
  return [
    defineReadTool({
      name: "list_waitpoint_tokens",
      title: "List Waitpoint Tokens",
      description:
        "List the waitpoint tokens of an environment, newest first, like the Waitpoint tokens page in the dashboard: each token's status, when it was created, timed out or completed, its idempotency key and tags. Filter by status, tag, idempotency key and time period. Pass the returned cursor to list older ones.",
      shape: ListWaitpointTokensInput.shape,
      auth,
      run: async (input, ctx) => {
        const filter = statusFilter(input.statuses);
        if (!filter) return plainError(WAITING_AND_TIMED_OUT);
        const waitpointEngine = await engine();
        const budget = startReadBudget(readBudgetMs, ctx.signal);
        const resolved = await budget.read(() => resolveToolEnvironment(ctx));
        if (!resolved.ok) return plainError(stoppedText(resolved));
        const environment = resolved.value;
        if (!environment) return plainError("Environment not found");

        const presenter = new WaitpointListPresenter(
          undefined,
          undefined,
          undefined,
          runStore,
          waitpointEngine
        );
        let read;
        try {
          read = await budget.read(() =>
            presenter.call({
              environment,
              ...filter,
              tags: input.tags,
              idempotencyKey: input.idempotencyKey,
              period: input.period,
              cursor: input.cursor,
              pageSize: input.limit,
            })
          );
        } catch (error) {
          logWaitpointToolError("list_waitpoint_tokens", error);
          return plainError("Could not list waitpoint tokens. Try again later.");
        }
        if (!read.ok) return plainError(stoppedText(read));
        const result = read.value;
        if (!result.success) {
          return plainError(
            result.code === "ENGINE_VERSION_MISMATCH"
              ? "Waitpoint tokens need SDK version 4 or later in this project."
              : "Could not list waitpoint tokens. Try again later."
          );
        }

        const next = renderWaitpointCursor(result.pagination.next);
        if (result.tokens.length === 0) {
          // A page can stop short of its first match, so an empty page with a cursor is not the end.
          return textResult(
            next
              ? `No tokens matched in this part of the list; older ones may. Pass cursor ${next} to keep looking.`
              : input.cursor
                ? "No older waitpoint tokens."
                : "No waitpoint tokens match these filters."
          );
        }
        return textResult(
          [
            `Found ${result.tokens.length} waitpoint token${result.tokens.length === 1 ? "" : "s"}:`,
            ...result.tokens.map(renderTokenRow),
            ...(next ? [`More tokens exist. Pass cursor ${next} to list older ones.`] : []),
          ].join("\n")
        );
      },
    }),
    defineReadTool({
      name: "get_waitpoint_token",
      title: "Get Waitpoint Token",
      description:
        "Get a waitpoint, like the waitpoint page in the dashboard: its type, status, idempotency key, tags, timeout, when it completed, its output, and the runs that waited on it (their status and task need read:runs). The output is shortened when long. The ID starts with waitpoint_",
      shape: GetWaitpointTokenInput.shape,
      auth,
      run: async (input, ctx) => {
        const waitpointEngine = await engine();
        const budget = startReadBudget(readBudgetMs, ctx.signal);
        const resolved = await budget.read(() => resolveToolEnvironment(ctx));
        if (!resolved.ok) return plainError(stoppedText(resolved, "lookup"));
        const environment = resolved.value;
        if (!environment) return plainError("Environment not found");

        const id = WaitpointId.toId(input.waitpointId);
        const scope = {
          organizationId: environment.organizationId,
          projectId: environment.projectId,
          environmentId: environment.id,
        };
        const withRuns =
          ctx.ability?.can("read", { type: "runs", envType: environment.type }) ?? false;
        let read;
        try {
          read = await budget.read(async () => {
            const token = await new ApiWaitpointPresenter(
              undefined,
              undefined,
              undefined,
              runStore,
              (s) => waitpointEngine.getStoreDateTimeWaitpoint(s)
            )
              .call(environment, id)
              .catch((error: unknown) => {
                if (error instanceof ServiceValidationError) return null;
                throw error;
              });
            if (!token) return null;
            const storeDateTime = await isStoreWaitpoint(
              waitpointEngine,
              id,
              environment.organizationId
            );
            return {
              token,
              ...(await connectedRuns(waitpointEngine, id, storeDateTime, scope, withRuns)),
            };
          });
        } catch (error) {
          logWaitpointToolError("get_waitpoint_token", error);
          return plainError(WAITPOINT_READ_FAILED);
        }
        if (!read.ok) return plainError(stoppedText(read, "lookup"));
        const found = read.value;
        if (!found || found.foreign) return plainError(waitpointNotFound(input.waitpointId));

        const { url: _url, ...token } = found.token;
        const output = await shownOutput(token.output, token.outputType);
        return textResult(renderTokenDetail({ ...token, output }, found.runs, withRuns));
      },
    }),
  ];
}

export const waitpointsTools: McpToolDefinition[] = createWaitpointsTools();
