import { json } from "@remix-run/node";
import { err, fromPromise, fromSafePromise, ok } from "neverthrow";
import z from "zod";
import { logger } from "~/services/logger.server";
import { type RemoteBuildProviderStatusResponseBody } from "@trigger.dev/core/v3/schemas";

const DEPOT_STATUS_URL = "https://status.depot.dev/proxy/status.depot.dev";
const FETCH_TIMEOUT_MS = 2000;

export async function loader() {
  return await fetchDepotStatus().match(
    ({ summary: { ongoing_incidents } }) => {
      if (ongoing_incidents.length > 0) {
        return json(
          {
            status: "degraded",
            message:
              "Our remote build provider is currently facing issues. You can use the `--force-local-build` flag to build and deploy the image locally. Read more about local builds here: https://docs.trigger.dev/deploy/local-builds",
          } satisfies RemoteBuildProviderStatusResponseBody,
          { status: 200 }
        );
      }

      return json(
        {
          status: "operational",
          message: "Depot is operational",
        } satisfies RemoteBuildProviderStatusResponseBody,
        { status: 200 }
      );
    },
    () => {
      return json(
        {
          status: "unknown",
          message: "Failed to fetch remote build provider status",
        } satisfies RemoteBuildProviderStatusResponseBody,
        { status: 200 }
      );
    }
  );
}

function fetchDepotStatus() {
  return fromPromise(
    fetch(DEPOT_STATUS_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }),
    (error) => {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        return {
          type: "timeout" as const,
        };
      }

      return {
        type: "other" as const,
        cause: error,
      };
    }
  )
    .andThen((response) => {
      if (!response.ok) {
        return err({
          type: "other" as const,
          cause: new Error(`Failed to fetch Depot status: ${response.status}`),
        });
      }

      return fromSafePromise(response.json());
    })
    .andThen((json) => {
      const parsed = DepotStatusResponseSchema.safeParse(json);

      if (!parsed.success) {
        logger.warn("Invalid Depot status response", { error: parsed.error });
        return err({
          type: "validation_failed" as const,
        });
      }

      return ok(parsed.data);
    });
}

// partial schema
const DepotStatusResponseSchema = z.object({
  summary: z.object({
    ongoing_incidents: z.array(z.any()),
  }),
});
