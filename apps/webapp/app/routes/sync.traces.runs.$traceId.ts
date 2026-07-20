import type { LoaderFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { getUserId } from "~/services/session.server";
import { longPollingFetch } from "~/utils/longPollingFetch";
import {
  OtelTraceIdSchema,
  RESERVED_ELECTRIC_SHAPE_PARAMS,
  buildElectricTraceWhereClause,
} from "~/v3/electricShape.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { runStore } from "~/v3/runStore.server";

const Params = z.object({
  traceId: OtelTraceIdSchema,
});

export async function loader({ params, request }: LoaderFunctionArgs) {
  try {
    const userId = await getUserId(request);

    const parsedParams = Params.safeParse(params);
    if (!parsedParams.success) {
      return new Response("Not found", { status: 404 });
    }
    const { traceId } = parsedParams.data;

    logger.log(`/sync/runs/${traceId}`, { userId });

    if (!userId) {
      return new Response("No user found in cookie", { status: 401 });
    }

    let run = await runStore.findRun(
      {
        traceId,
      },
      {
        select: {
          projectId: true,
          runtimeEnvironmentId: true,
        },
      },
      $replica
    );

    if (!run) {
      // Read-your-writes: a just-created run may not have replicated yet. Re-read the owning
      // primary before 404ing so a live run's realtime trace feed isn't spuriously not-found.
      run = await runStore.findRunOnPrimary(
        { traceId },
        { select: { projectId: true, runtimeEnvironmentId: true } }
      );
    }

    if (!run) {
      return new Response("No run found", { status: 404 });
    }

    const resolvedEnv = await controlPlaneResolver.resolveEnv(run.runtimeEnvironmentId);

    if (!resolvedEnv) {
      return new Response("No run found", { status: 404 });
    }

    const member = await $replica.orgMember.findFirst({
      where: {
        organizationId: resolvedEnv.organizationId,
        userId,
      },
    });

    if (!member) {
      return new Response("Not a member of this org", { status: 401 });
    }

    const url = new URL(request.url);
    const originUrl = new URL(`${env.ELECTRIC_ORIGIN}/v1/shape/public."TaskRun"`);
    // Strip params we set ourselves so the caller can't override them.
    url.searchParams.forEach((value, key) => {
      if (RESERVED_ELECTRIC_SHAPE_PARAMS.has(key)) return;
      originUrl.searchParams.set(key, value);
    });

    originUrl.searchParams.set(
      "where",
      // Scope by non-null projectId, not the nullable organizationId (legacy
      // rows would vanish). Tenant-safe: membership was verified against this
      // project's org and a trace's runs all live in one project.
      buildElectricTraceWhereClause({
        traceId,
        scope: { column: "projectId", id: run.projectId },
      })
    );

    const finalUrl = originUrl.toString();

    logger.log("Fetching trace runs data", { url: finalUrl });

    return longPollingFetch(finalUrl);
  } catch (error) {
    if (error instanceof Response) {
      // Error responses from longPollingFetch
      return error;
    } else if (error instanceof TypeError) {
      // Unexpected errors
      logger.error("Unexpected error in loader:", { error: error.message });
      return new Response("An unexpected error occurred", { status: 500 });
    } else {
      // Unknown errors
      logger.error("Unknown error occurred in loader, not Error", { error: JSON.stringify(error) });
      return new Response("An unknown error occurred", { status: 500 });
    }
  }
}
