import { getMeter } from "@internal/tracing";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { singleton } from "~/utils/singleton";
import { realtimeClient } from "../realtimeClientGlobal.server";
import { ClickHouseRunListResolver } from "./clickHouseRunListResolver.server";
import { RunHydrator } from "./runReader.server";
import { RealtimeShadowComparator } from "./shadowCompare.server";
import { ShadowRealtimeClient } from "./shadowRealtimeClient.server";

/**
 * Process-singleton wiring for the shadow-compare client. Only constructed
 * when an org's `realtimeBackend` flag is set to "shadow".
 */
function initializeShadowRealtimeClient(): ShadowRealtimeClient {
  const compares = getMeter("realtime-shadow").createCounter("realtime_shadow.compares", {
    description:
      "Dual-run shadow-compare outcomes (Electric vs native). kind=serialization|membership, result=match|diverge|skew.",
  });

  const comparator = new RealtimeShadowComparator({
    runReader: new RunHydrator({ replica: $replica }),
    runListResolver: new ClickHouseRunListResolver({
      getClickhouse: (organizationId) =>
        clickhouseFactory.getClickhouseForOrganization(organizationId, "realtime"),
      prisma: $replica,
    }),
  });

  return new ShadowRealtimeClient({
    electric: realtimeClient,
    comparator,
    maximumCreatedAtFilterAgeMs: env.REALTIME_MAXIMUM_CREATED_AT_FILTER_AGE_IN_MS,
    maxListResults: env.REALTIME_BACKEND_NATIVE_MAX_LIST_RESULTS,
    onOutcome: (outcome) => {
      const { feed } = outcome;
      if (outcome.serializationMatched) {
        compares.add(outcome.serializationMatched, { feed, kind: "serialization", result: "match" });
      }
      if (outcome.serializationDiverged) {
        compares.add(outcome.serializationDiverged, {
          feed,
          kind: "serialization",
          result: "diverge",
        });
      }
      if (outcome.serializationSkew) {
        compares.add(outcome.serializationSkew, { feed, kind: "serialization", result: "skew" });
      }
      if (outcome.membershipMatch !== undefined) {
        compares.add(1, {
          feed,
          kind: "membership",
          result: outcome.membershipMatch ? "match" : "diverge",
        });
      }
    },
  });
}

export function getShadowRealtimeClient(): ShadowRealtimeClient {
  return singleton("shadowRealtimeClient", initializeShadowRealtimeClient);
}
