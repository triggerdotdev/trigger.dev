import { json } from "@remix-run/server-runtime";
import {
  CreateSessionRequestBody,
  type CreatedSessionResponseBody,
  ListSessionsQueryParams,
  type ListSessionsResponseBody,
  type SessionItem,
  type SessionStatus,
} from "@trigger.dev/core/v3";
import type { Prisma, Session } from "@trigger.dev/database";
import { $replica, prisma, type PrismaClient } from "~/db.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { logger } from "~/services/logger.server";
import { mintSessionToken } from "~/services/realtime/mintSessionToken.server";
import {
  isSafeSessionExternalId,
  SESSION_CHANNEL_SCOPE_INFIX,
} from "~/services/realtime/sessionChannels.server";
import {
  ensureRunForSession,
  type SessionTriggerConfig,
} from "~/services/realtime/sessionRunManager.server";
import {
  findOrCreateSession,
  serializeSession,
  serializeSessionsWithFriendlyRunIds,
} from "~/services/realtime/sessions.server";
import { SessionsRepository } from "~/services/sessionsRepository/sessionsRepository.server";
import {
  anyResource,
  createActionApiRoute,
  createLoaderApiRoute,
  everyResource,
} from "~/services/routeBuilders/apiBuilder.server";
import {
  recordSessionCreateAuthorization,
  sessionCreateAuthorizationOutcome,
} from "~/services/sessionAuthorizationTelemetry.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import { runStore } from "~/v3/runStore.server";

function asArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

export const loader = createLoaderApiRoute(
  {
    searchParams: ListSessionsQueryParams,
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "read",
      // Multi-key resource preserves the pre-RBAC superScope semantics:
      //   - Per-task scoping via `read:tasks:<id>` matches a task element
      //   - Type-level `read:sessions` (the old superScope) matches the
      //     sessions element (collection-level — no id)
      //   - `read:all` / `admin` bypass via the JWT ability's wildcard branches
      // The taskIdentifier filter accepts a string or an array. Broad
      // sessions/tasks scopes remain alternatives, while ID-scoped keys must
      // match every requested task so one allowed filter cannot expose others.
      resource: (_, __, searchParams) => {
        const taskFilter = asArray(searchParams["filter[taskIdentifier]"]) ?? [];
        if (taskFilter.length === 0) {
          return anyResource([{ type: "sessions" as const }, { type: "tasks" as const }]);
        }

        return everyResource(
          taskFilter.map((id) => ({ type: "tasks" as const, id })),
          [{ type: "sessions" as const }, { type: "tasks" as const }]
        );
      },
    },
    findResource: async () => 1,
  },
  async ({ searchParams, authentication }) => {
    const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
      authentication.environment.organizationId,
      "standard"
    );
    const repository = new SessionsRepository({
      clickhouse,
      prisma: $replica as PrismaClient,
    });

    // `page[after]` is the forward cursor, `page[before]` is the backward
    // cursor. The repository internally keys off `{cursor, direction}`.
    const cursor = searchParams["page[after]"] ?? searchParams["page[before]"];
    const direction = searchParams["page[before]"] ? "backward" : "forward";

    const { sessions: rows, pagination } = await repository.listSessions({
      organizationId: authentication.environment.organizationId,
      projectId: authentication.environment.projectId,
      environmentId: authentication.environment.id,
      types: asArray(searchParams["filter[type]"]),
      tags: asArray(searchParams["filter[tags]"]),
      taskIdentifiers: asArray(searchParams["filter[taskIdentifier]"]),
      externalId: searchParams["filter[externalId]"],
      statuses: asArray(searchParams["filter[status]"]) as SessionStatus[] | undefined,
      period: searchParams["filter[createdAt][period]"],
      from: searchParams["filter[createdAt][from]"],
      to: searchParams["filter[createdAt][to]"],
      page: {
        size: searchParams["page[size]"],
        cursor,
        direction,
      },
    });

    // Batched friendlyId translation: `currentRunId` on the wire is the
    // public `run_*` form, matching the single-session routes. One `IN`
    // lookup per page.
    const data = await serializeSessionsWithFriendlyRunIds(
      rows.map(
        (row) =>
          ({
            ...row,
            // Columns the list query doesn't select — filled so the
            // serializer can operate on a narrowed payload without type errors.
            projectId: authentication.environment.projectId,
            environmentType: authentication.environment.type,
            organizationId: authentication.environment.organizationId,
          }) as Session
      ),
      {
        projectId: authentication.environment.projectId,
        runtimeEnvironmentId: authentication.environment.id,
      }
    );

    return json<ListSessionsResponseBody>({
      data,
      pagination: {
        ...(pagination.nextCursor ? { next: pagination.nextCursor } : {}),
        ...(pagination.previousCursor ? { previous: pagination.previousCursor } : {}),
      },
    });
  }
);

const { action } = createActionApiRoute(
  {
    body: CreateSessionRequestBody,
    method: "POST",
    maxContentLength: 1024 * 32, // 32KB — metadata is the only thing that grows
    // Customer's server (typically wrapping
    // `chat.createStartSessionAction`) owns session creation so any
    // authorization decision (per-user/plan/quota) sits server-side
    // alongside whatever DB write the customer pairs with the create.
    // The session-scoped PAT returned in the response body is what the
    // browser uses thereafter against `.in/append`, `.out` SSE,
    // `end-and-continue`, etc.
    //
    // Creating a session requires session-write AND task-trigger permissions.
    allowJWT: true,
    authorization: {
      // Session-write is checked below after resolving alternate session IDs.
      action: "trigger",
      resource: (_params, _searchParams, _headers, body) => ({
        type: "tasks",
        id: body.taskIdentifier,
      }),
    },
    corsStrategy: "all",
  },
  async ({ authentication, body, ability, request }) => {
    try {
      if (body.externalId && !isSafeSessionExternalId(body.externalId)) {
        return json(
          {
            error: `externalId cannot contain "${SESSION_CHANNEL_SCOPE_INFIX}" or end in ":out" or ":in"`,
          },
          { status: 422 }
        );
      }

      const sessionIds = body.externalId ? [body.externalId] : [];
      if (body.externalId && !ability.can("write", { type: "sessions", id: body.externalId })) {
        const existing = await prisma.session.findFirst({
          where: {
            runtimeEnvironmentId: authentication.environment.id,
            externalId: body.externalId,
          },
          select: { friendlyId: true },
        });
        if (existing) sessionIds.push(existing.friendlyId);
      }
      if (
        sessionCreateAuthorizationOutcome(ability, body.taskIdentifier, sessionIds) !==
        "both_allowed"
      ) {
        return json({ error: "Unauthorized" }, { status: 403 });
      }

      // Defer cached config changes until the stored task has been authorized.
      const { session, isCached } = await findOrCreateSession({
        environment: authentication.environment,
        externalId: body.externalId,
        type: body.type,
        taskIdentifier: body.taskIdentifier,
        triggerConfig: body.triggerConfig,
        tags: body.tags,
        metadata: body.metadata as Record<string, unknown> | undefined,
        expiresAt: body.expiresAt,
        refreshTriggerConfig: false,
      });

      // Reject create on a closed session. The upsert path will return
      // an already-closed row when the caller reuses an externalId, and
      // without this guard `ensureRunForSession` would trigger a fresh
      // run that can't receive `.in` input (the append handler 409s on
      // closed sessions). Force the caller to use a different externalId
      // — `close` is one-way.
      if (session.closedAt) {
        return json(
          { error: "Session is closed; use a different externalId to create a new session" },
          { status: 409 }
        );
      }

      // Same guard as the append / end-and-continue handlers: an expired
      // row must not spawn a run, because every subsequent `.in/append`
      // would 400 on the expiry check — a run boots but the chat can
      // never receive input.
      if (session.expiresAt && session.expiresAt.getTime() < Date.now()) {
        return json(
          { error: "Session is expired; use a different externalId to create a new session" },
          { status: 409 }
        );
      }

      recordSessionCreateAuthorization(ability, session, request, authentication.environment);
      if (
        sessionCreateAuthorizationOutcome(
          ability,
          session.taskIdentifier,
          [session.friendlyId, session.externalId].filter((id): id is string => !!id)
        ) !== "both_allowed"
      ) {
        return json({ error: "Unauthorized" }, { status: 403 });
      }

      if (isCached) {
        Object.assign(
          session,
          await prisma.session.update({
            where: { id: session.id },
            data: { triggerConfig: body.triggerConfig as unknown as Prisma.InputJsonValue },
            select: { triggerConfig: true, updatedAt: true },
          })
        );
      }

      // Session is task-bound — every session has a live run by
      // construction. `ensureRunForSession` is idempotent: on the
      // cached path it sees `currentRunId` is alive and returns it
      // without re-triggering.
      const ensureResult = await ensureRunForSession({
        session,
        environment: authentication.environment,
        reason: isCached ? "continuation" : "initial",
      });

      // Read-after-write: the run was just triggered in this request,
      // so go to the writer rather than $replica. Replica lag here
      // would null this out and turn a successful create into a 500.
      const run = await runStore.findRun(
        { id: ensureResult.runId },
        { select: { friendlyId: true } },
        prisma
      );
      if (!run) {
        throw new Error(`Triggered run ${ensureResult.runId} not found`);
      }

      // Mint a session-scoped PAT keyed on the addressing string the
      // transport will use everywhere (`.in/append`, `.out` SSE,
      // `end-and-continue`). For sessions with an externalId, that's
      // the externalId; otherwise the friendlyId. Mirrors the
      // canonical addressing key used server-side.
      const addressingKey = session.externalId ?? session.friendlyId;
      const publicAccessToken = await mintSessionToken(authentication.environment, addressingKey);

      const sessionItem: SessionItem = {
        ...serializeSession(session),
        triggerConfig: session.triggerConfig as unknown as SessionTriggerConfig,
        currentRunId: run.friendlyId,
      };

      const responseBody: CreatedSessionResponseBody = {
        ...sessionItem,
        runId: run.friendlyId,
        publicAccessToken,
        isCached,
        pendingVersion: ensureResult.pendingVersion,
      };

      return json<CreatedSessionResponseBody>(responseBody, {
        status: isCached ? 200 : 201,
      });
    } catch (error) {
      if (error instanceof ServiceValidationError) {
        return json({ error: error.message }, { status: 422 });
      }
      logger.error("Failed to create session", {
        error,
        environmentId: authentication.environment.id,
      });
      return json({ error: "Something went wrong" }, { status: 500 });
    }
  }
);

export { action };
