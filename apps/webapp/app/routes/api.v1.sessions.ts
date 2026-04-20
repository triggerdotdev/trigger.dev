import { json } from "@remix-run/server-runtime";
import {
  CreateSessionRequestBody,
  type CreatedSessionResponseBody,
  ListSessionsQueryParams,
  type ListSessionsResponseBody,
  type SessionStatus,
} from "@trigger.dev/core/v3";
import { SessionId } from "@trigger.dev/core/v3/isomorphic";
import type { Prisma, Session } from "@trigger.dev/database";
import { $replica, prisma, type PrismaClient } from "~/db.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { logger } from "~/services/logger.server";
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
      resource: (_, __, searchParams) => ({ tasks: searchParams["filter[taskIdentifier]"] }),
      superScopes: ["read:sessions", "read:all", "admin"],
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
      data: rows.map((session) =>
        serializeSession({
          ...session,
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
  },
  async ({ authentication, body }) => {
    try {
      let session: Session;
      let isCached = false;

      if (body.externalId) {
        // Atomic upsert — two concurrent POSTs with the same externalId both
        // converge to the same row without either hitting a 500 from the
        // unique constraint. Derive isCached from the upsert result: if the
        // row pre-existed, the returned id won't match the one we just
        // generated. Saves a round-trip and is race-free.
        const { id, friendlyId } = SessionId.generate();
        const externalId = body.externalId;

        session = await prisma.session.upsert({
          where: {
            runtimeEnvironmentId_externalId: {
              runtimeEnvironmentId: authentication.environment.id,
              externalId,
            },
          },
          create: {
            id,
            friendlyId,
            externalId,
            type: body.type,
            taskIdentifier: body.taskIdentifier ?? null,
            tags: body.tags ?? [],
            metadata: body.metadata as Prisma.InputJsonValue | undefined,
            expiresAt: body.expiresAt ?? null,
            projectId: authentication.environment.projectId,
            runtimeEnvironmentId: authentication.environment.id,
            environmentType: authentication.environment.type,
            organizationId: authentication.environment.organizationId,
          },
          update: {},
        });
        isCached = session.id !== id;
      } else {
        const { id, friendlyId } = SessionId.generate();
        session = await prisma.session.create({
          data: {
            id,
            friendlyId,
            type: body.type,
            taskIdentifier: body.taskIdentifier ?? null,
            tags: body.tags ?? [],
            metadata: body.metadata as Prisma.InputJsonValue | undefined,
            expiresAt: body.expiresAt ?? null,
            projectId: authentication.environment.projectId,
            runtimeEnvironmentId: authentication.environment.id,
            environmentType: authentication.environment.type,
            organizationId: authentication.environment.organizationId,
          },
        });
      }

      return json<CreatedSessionResponseBody>(
        { ...serializeSession(session), isCached },
        { status: isCached ? 200 : 201 }
      );
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
