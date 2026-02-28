import { json } from "@remix-run/server-runtime";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { DeadLetterManagementService } from "~/v3/services/events/deadLetterManagement.server";

export const loader = createLoaderApiRoute(
  {
    corsStrategy: "all",
    authorization: {
      action: "read",
      resource: () => ({ tasks: "*" }),
      superScopes: ["read:runs", "read:all", "admin"],
    },
    findResource: async () => 1 as const,
  },
  async ({ authentication, request }) => {
    const url = new URL(request.url);
    const eventType = url.searchParams.get("eventType") ?? undefined;
    const status = url.searchParams.get("status") as
      | "PENDING"
      | "RETRIED"
      | "DISCARDED"
      | undefined;
    const limit = url.searchParams.get("limit")
      ? parseInt(url.searchParams.get("limit")!, 10)
      : undefined;
    const cursor = url.searchParams.get("cursor") ?? undefined;

    const service = new DeadLetterManagementService();
    const result = await service.list({
      projectId: authentication.environment.projectId,
      environmentId: authentication.environment.id,
      eventType,
      status,
      limit,
      cursor,
    });

    return json({
      data: result.data.map((dle) => ({
        id: dle.id,
        friendlyId: dle.friendlyId,
        eventType: dle.eventType,
        payload: dle.payload,
        taskSlug: dle.taskSlug,
        failedRunId: dle.failedRunId,
        error: dle.error,
        attemptCount: dle.attemptCount,
        status: dle.status,
        sourceEventId: dle.sourceEventId,
        createdAt: dle.createdAt.toISOString(),
        processedAt: dle.processedAt?.toISOString() ?? null,
      })),
      pagination: result.pagination,
    });
  }
);
