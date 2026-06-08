import { Counter } from "prom-client";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { metricsRegister } from "~/metrics.server";
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
  const compares = new Counter({
    name: "realtime_shadow_compare_total",
    help: "Dual-run shadow-compare outcomes (Electric vs notifier). kind=serialization|membership, result=match|diverge|skew.",
    labelNames: ["feed", "kind", "result"] as const,
    registers: [metricsRegister],
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
    maxListResults: env.REALTIME_NOTIFIER_MAX_LIST_RESULTS,
    onOutcome: (outcome) => {
      const { feed } = outcome;
      if (outcome.serializationMatched) {
        compares.inc({ feed, kind: "serialization", result: "match" }, outcome.serializationMatched);
      }
      if (outcome.serializationDiverged) {
        compares.inc(
          { feed, kind: "serialization", result: "diverge" },
          outcome.serializationDiverged
        );
      }
      if (outcome.serializationSkew) {
        compares.inc({ feed, kind: "serialization", result: "skew" }, outcome.serializationSkew);
      }
      if (outcome.membershipMatch !== undefined) {
        compares.inc({
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
