import { json } from "@remix-run/server-runtime";
import {
  CreateSessionRequestBody,
  type CreatedSessionResponseBody,
  ListSessionsQueryParams,
  type ListSessionsResponseBody,
  type SessionItem,
  type SessionStatus,
} from "@trigger.dev/core/v3";
import { SessionId } from "@trigger.dev/core/v3/isomorphic";
import type { Prisma, Session } from "@trigger.dev/database";
import { $replica, prisma, type PrismaClient } from "~/db.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { logger } from "~/services/logger.server";
import { mintSessionToken } from "~/services/realtime/mintSessionToken.server";
import {
  ensureRunForSession,
  type SessionTriggerConfig,
} from "~/services/realtime/sessionRunManager.server";
import { serializeSession } from "~/services/realtime/sessions.server";
import { SessionsRepository } from "~/services/sessionsRepository/sessionsRepository.server";
import {
  createActionApiRoute,
  createLoaderApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";
import { ServiceValidationError } from "~/v3/services/common.server";

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
      // The taskIdentifier filter accepts a string or an array; expand to
      // one resource per task id so any per-task-scoped JWT among them
      // grants access (the array gets OR semantics).
      resource: (_, __, searchParams) => {
        const taskFilter = asArray(searchParams["filter[taskIdentifier]"]) ?? [];
        return [
          ...taskFilter.map((id) => ({ type: "tasks" as const, id })),
          { type: "sessions" as const },
        ];
      },
    },
    findResource: async () => 1,
  },
  async ({ searchParams, authentication }) => {
    const repository = new SessionsRepository({
      clickhouse: clickhouseClient,
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

    return json<ListSessionsResponseBody>({
      data: rows.map((row) =>
        serializeSession({
          ...row,
          // Columns the list query doesn't select — filled so `serializeSession`
          // can operate on a narrowed payload without type errors.
          projectId: authentication.environment.projectId,
          environmentType: authentication.environment.type,
          organizationId: authentication.environment.organizationId,
        } as Session)
      ),
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
    // JWT is allowed when the caller holds an explicit `write:sessions` /
    // `admin` super-scope plus a `tasks:<taskIdentifier>` scope — gates
    // server-side surfaces like the cli-v3 MCP from creating sessions on
    // behalf of the developer without weakening the browser model.
    allowJWT: true,
    authorization: {
      // Per-task scoping via `body.taskIdentifier` (action-route resource
      // callbacks receive the parsed body as the 4th arg — see
      // `apiBuilder.server.ts:710`). A JWT scoped only to `write:tasks:foo`
      // can only create sessions whose `taskIdentifier` is `"foo"`.
      //
      // Multi-key resource: pre-RBAC this route had a `superScopes:
      // ["write:sessions", "admin"]` whitelist; post-RBAC the equivalent
      // is the `{ type: "sessions" }` element below — a `write:sessions`
      // JWT (no id) matches it directly, deliberately bypassing the
      // per-task check exactly as before. `admin` / `write:all` bypass
      // via the JWT ability's wildcard branches.
      action: "write",
      resource: (_params, _searchParams, _headers, body) => [
        { type: "tasks", id: body.taskIdentifier },
        { type: "sessions" },
      ],
    },
    corsStrategy: "all",
  },
  async ({ authentication, body }) => {
    try {
      const { id, friendlyId } = SessionId.generate();

      // Idempotent on (env, externalId): two concurrent POSTs converge
      // to the same row. We refresh `triggerConfig` on the cached path
      // so newly-deployed schema changes (e.g. an updated
      // `clientDataSchema` on the agent) propagate to subsequent runs
      // — the next `ensureRunForSession` reads back the latest config.
      let session: Session;
      let isCached = false;

      const triggerConfigJson = body.triggerConfig as unknown as Prisma.InputJsonValue;

      if (body.externalId) {
        session = await prisma.session.upsert({
          where: {
            runtimeEnvironmentId_externalId: {
              runtimeEnvironmentId: authentication.environment.id,
              externalId: body.externalId,
            },
          },
          create: {
            id,
            friendlyId,
            externalId: body.externalId,
            type: body.type,
            taskIdentifier: body.taskIdentifier,
            triggerConfig: triggerConfigJson,
            tags: body.tags ?? [],
            metadata: body.metadata as Prisma.InputJsonValue | undefined,
            expiresAt: body.expiresAt ?? null,
            projectId: authentication.environment.projectId,
            runtimeEnvironmentId: authentication.environment.id,
            environmentType: authentication.environment.type,
            organizationId: authentication.environment.organizationId,
            streamBasinName: authentication.environment.organization.streamBasinName,
          },
          update: { triggerConfig: triggerConfigJson },
        });
        isCached = session.id !== id;
      } else {
        session = await prisma.session.create({
          data: {
            id,
            friendlyId,
            type: body.type,
            taskIdentifier: body.taskIdentifier,
            triggerConfig: triggerConfigJson,
            tags: body.tags ?? [],
            metadata: body.metadata as Prisma.InputJsonValue | undefined,
            expiresAt: body.expiresAt ?? null,
            projectId: authentication.environment.projectId,
            runtimeEnvironmentId: authentication.environment.id,
            environmentType: authentication.environment.type,
            organizationId: authentication.environment.organizationId,
            streamBasinName: authentication.environment.organization.streamBasinName,
          },
        });
      }

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
      const run = await prisma.taskRun.findFirst({
        where: { id: ensureResult.runId },
        select: { friendlyId: true },
      });
      if (!run) {
        throw new Error(`Triggered run ${ensureResult.runId} not found`);
      }

      // Mint a session-scoped PAT keyed on the addressing string the
      // transport will use everywhere (`.in/append`, `.out` SSE,
      // `end-and-continue`). For sessions with an externalId, that's
      // the externalId; otherwise the friendlyId. Mirrors the
      // canonical addressing key used server-side.
      const addressingKey = session.externalId ?? session.friendlyId;
      const publicAccessToken = await mintSessionToken(
        authentication.environment,
        addressingKey
      );

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
      };

      return json<CreatedSessionResponseBody>(responseBody, {
        status: isCached ? 200 : 201,
      });
    } catch (error) {
      if (error instanceof ServiceValidationError) {
        return json({ error: error.message }, { status: 422 });
      }
      logger.error("Failed to create session", { error });
      return json({ error: "Something went wrong" }, { status: 500 });
    }
  }
);

export { action };
