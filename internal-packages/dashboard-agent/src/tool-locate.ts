import { locateResultSchema, type locatedScopeSchema } from "@internal/dashboard-agent-contracts";
import { tool, type ToolSet } from "ai";
import type { z } from "zod";
import { locateSchema } from "./tool-schemas";
import { apiGet, fetchReason, NO_AUTH, type DashboardAgentApiClient } from "./tool-api-client";
import type { DashboardAgentToolContext } from "./tool-context";
import { recordRead } from "./tool-read-scope";
import type { ReadScope, SourceReadLedger } from "./tool-source-ledger";

// Org-scoped: uses the delegated token, never an environment JWT — the point is finding
// the environment before targeting it.

// Mirrors `ParamsSchema` in `api.v1.locate.$kind.$id.ts`.
const RUN_ID = /^run_.+$/;
const DEPLOYMENT_ID = /^deployment_.+$/;

type LocateKind = "run" | "deployment" | "error" | "queue";

function validateLocateId(kind: LocateKind, id: string): string | null {
  if (kind === "run" && !RUN_ID.test(id)) return `"${id}" isn't a run id (run_...).`;
  if (kind === "deployment" && !DEPLOYMENT_ID.test(id)) {
    return `"${id}" isn't a deployment id (deployment_...). Deployments are addressable only by id, never by version.`;
  }
  if (kind === "error" && id.length === 0) return "An error id or fingerprint can't be empty.";
  if (kind === "queue" && id.trim().length === 0) return "A queue name can't be empty.";
  return null;
}

/** A failed warehouse lookup is surfaced as an error, never as `found: false`. */
function notFoundResponse(kind: LocateKind, id: string, data: unknown) {
  const parsed = locateResultSchema.safeParse(data);
  const notFound = parsed.success && !parsed.data.found ? parsed.data : undefined;
  if (notFound?.unavailable) {
    return { error: `Couldn't check ${kind} ${id} right now — try again.` };
  }
  return { found: false as const, ...(notFound?.truncated ? { truncated: true as const } : {}) };
}

function nextHint(kind: LocateKind, scope: z.infer<typeof locatedScopeSchema>): string {
  const parts = [`project=${scope.projectRef}`, `environment=${scope.environmentName}`];
  if (scope.branch) parts.push(`branch=${scope.branch}`);
  let target = "the relevant tool";
  if (kind === "deployment" && scope.version) target = `get_deploy version=${scope.version}`;
  if (kind === "queue" && scope.queueName) {
    const type = scope.queueType ? ` type=${scope.queueType}` : "";
    target = `get_queue queue=${scope.queueName}${type}`;
  }
  return `call ${target} with ${parts.join(" ")}`;
}

// Records every scope `locate` found an object in, so a follow-up call canonicalizes
// against the scope it was actually found in, rather than the conversation's own.
function recordLocatedScopes(
  reads: SourceReadLedger | undefined,
  kind: LocateKind,
  id: string,
  scopes: z.infer<typeof locatedScopeSchema>[]
): void {
  if (!reads) return;
  for (const scope of scopes) {
    const readScope: ReadScope = {
      projectRef: scope.projectRef,
      environmentId: scope.environmentId,
      environmentName: scope.environmentName,
    };
    // A queue is cited by the name the read resolved, which may differ from what was asked.
    const recordId = kind === "queue" ? (scope.queueName ?? id) : id;
    recordRead(reads, kind, recordId, readScope);
  }
}

export function buildLocateTool(args: {
  ctx: DashboardAgentToolContext;
  client: DashboardAgentApiClient;
  reads?: SourceReadLedger;
}): ToolSet {
  const { ctx, client, reads } = args;
  const { origin, hasAuth } = client;
  const { userActorToken } = ctx;

  return {
    locate: tool({
      ...locateSchema,
      execute: async ({ kind, id }) => {
        if (!hasAuth) return NO_AUTH;
        const shapeError = validateLocateId(kind, id);
        if (shapeError) return { error: shapeError };

        const result = await apiGet(
          origin,
          `/api/v1/locate/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
          userActorToken!
        );
        if (!result.ok) {
          if ("status" in result) {
            if (result.status === 503) {
              return { error: `Couldn't check ${kind} ${id} right now — try again.` };
            }
            if (result.status === 404) return notFoundResponse(kind, id, result.data);
          }
          return { error: `Couldn't locate ${kind} ${id}${fetchReason(result)}.` };
        }

        const parsed = locateResultSchema.safeParse(result.data);
        if (!parsed.success) {
          return { error: `Couldn't locate ${kind} ${id} (unexpected response).` };
        }
        if (!parsed.data.found) return notFoundResponse(kind, id, result.data);
        const { kind: foundKind, id: foundId, scopes, truncated } = parsed.data;
        recordLocatedScopes(reads, foundKind, foundId, scopes);
        return {
          found: true,
          kind: foundKind,
          id: foundId,
          scopes: scopes.map((scope) => ({ ...scope, next: nextHint(foundKind, scope) })),
          ...(truncated ? { truncated: true } : {}),
        };
      },
    }),
  };
}
