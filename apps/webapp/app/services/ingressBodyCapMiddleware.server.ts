import { getMeter } from "@internal/tracing";
import type { ServerBuild } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import {
  createIngressBodyCap,
  createKeyedAllowance,
  createRouteIdMatcher,
  DASHBOARD_AGENT_INGRESS_CAP,
  otlpIngressCap,
  routeIngressCaps,
  OAUTH_INGRESS_CAP,
  SIGN_IN_FORM_INGRESS_CAP,
} from "./ingressBodyCap.server";
import { logger } from "./logger.server";
import { tenantContext } from "./tenantContext.server";

const KB = 1024;
const MB = 1024 * KB;

const BODY_SIZE_BUCKETS_BYTES = [
  1 * KB,
  4 * KB,
  16 * KB,
  64 * KB,
  256 * KB,
  512 * KB,
  1 * MB,
  2 * MB,
  4 * MB,
  8 * MB,
  16 * MB,
  32 * MB,
  64 * MB,
  128 * MB,
  256 * MB,
  1024 * MB,
];

/** Log lines for one route and limit, per process, per minute. The counter stays exact. */
const LOG_LINES_PER_MINUTE = 10;

const metrics = singleton("ingressBodyLimitMetrics", () => {
  const meter = getMeter("ingress-body-limit");

  return {
    exceeded: meter.createCounter("ingress.body_limit.exceeded", {
      description: "Requests whose body went over its ingress limit",
    }),
    size: meter.createHistogram("ingress.body.size", {
      description: "Request body size, by the ingress limit that applied",
      unit: "By",
      advice: { explicitBucketBoundaries: BODY_SIZE_BUCKETS_BYTES },
    }),
  };
});

export function createIngressBodyCapMiddleware(routes: ServerBuild["routes"]) {
  const routeIdFor = createRouteIdMatcher(routes);
  const logAllowance = createKeyedAllowance({ limit: LOG_LINES_PER_MINUTE, windowMs: 60_000 });

  return createIngressBodyCap({
    caps: [
      DASHBOARD_AGENT_INGRESS_CAP,
      SIGN_IN_FORM_INGRESS_CAP,
      OAUTH_INGRESS_CAP,
      otlpIngressCap(env.OTLP_INGRESS_BODY_SIZE_LIMIT_MB * MB),
      ...routeIngressCaps({
        taskPayloadBytes: env.TASK_PAYLOAD_MAXIMUM_SIZE,
        batchPayloadBytes: env.BATCH_TASK_PAYLOAD_MAXIMUM_SIZE,
        streamingBatchItemBytes: env.STREAMING_BATCH_ITEM_MAXIMUM_SIZE,
        streamingBatchMaxItems: env.STREAMING_BATCH_MAX_ITEMS,
        webhookBodyBytes: env.WEBHOOK_INGRESS_BODY_SIZE_LIMIT_MB * MB,
        runMetadataBytes: env.TASK_RUN_METADATA_MAXIMUM_SIZE,
      }),
    ],
    defaultLimitBytes: env.INGRESS_BODY_SIZE_LIMIT_MB * MB,
    mode: env.INGRESS_BODY_SIZE_LIMIT_MODE,
    // The handler fills this in once it has authenticated the request.
    capture: () => tenantContext.get(),
    onMeasured: (cap, bytes) => metrics.size.record(bytes, { cap }),
    onExceeded: ({ routerPath, ...event }, tenant) => {
      const route = routeIdFor(routerPath) ?? "unmatched";
      metrics.exceeded.add(1, { route, cap: event.cap, enforced: event.enforced });

      const { allowed, heldBack } = logAllowance(`${route} ${event.cap}`);
      if (!allowed) return;

      logger.warn("Request body over its ingress limit", {
        route,
        ...event,
        organizationId: tenant?.orgId,
        projectId: tenant?.projectId,
        environmentId: tenant?.envId,
        linesHeldBack: heldBack,
      });
    },
  });
}
