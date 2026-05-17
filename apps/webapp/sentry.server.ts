import * as Sentry from "@sentry/remix";
import { addOtelTraceContextToEvent } from "./app/utils/sentryTraceContext.server";

// Rules for collapsing high-volume errors into a single Sentry issue.
// Without this, e.g. a DB outage produces hundreds of distinct issues —
// one per stack trace — which buries other alerts. Add a new rule here
// when you spot another error that fans out across call sites. Keep
// predicates cheap (string compare, not regex over stack traces).
const FINGERPRINT_RULES: Array<{
  match: (err: { code?: unknown; errorCode?: unknown; name?: unknown }) => boolean;
  fingerprint: string;
  tags?: Record<string, string>;
}> = [
  {
    // Prisma surfaces P1001 on `code` for KnownRequestError (mid-query connection drop)
    // and `errorCode` for InitializationError (client failed to connect at startup).
    match: (err) => err.code === "P1001" || err.errorCode === "P1001",
    fingerprint: "prisma-p1001-db-unreachable",
    tags: { db_unreachable: "true" },
  },
];

if (process.env.SENTRY_DSN) {
  console.log("🔭 Initializing Sentry");

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    release: process.env.BUILD_GIT_SHA,

    // Adds request headers and IP for users, for more info visit: and captures action formData attributes
    // https://docs.sentry.io/platforms/javascript/guides/remix/configuration/options/#sendDefaultPii
    sendDefaultPii: false,

    skipOpenTelemetrySetup: true,
    registerEsmLoaderHooks: false,
    disableInstrumentationWarnings: true,

    maxBreadcrumbs: 0,
    shutdownTimeout: 10,

    serverName: process.env.SERVICE_NAME,
    environment: process.env.APP_ENV,

    // ServiceValidationError is thrown deliberately for user-facing
    // validation failures (quota, parent run state, invalid input). Anchored
    // regex matches the exception type exactly; subclasses
    // (QueueSizeLimitExceededError, MetadataTooLargeError) override `.name`
    // and stay visible.
    ignoreErrors: ["queryRoute() call aborted", /^ServiceValidationError(?::|$)/],
    includeLocalVariables: false,

    beforeSend(event, hint) {
      const err = hint.originalException as
        | { code?: unknown; errorCode?: unknown; name?: unknown }
        | undefined;
      if (!err) return event;

      const rule = FINGERPRINT_RULES.find((r) => r.match(err));
      if (!rule) return event;

      event.fingerprint = [rule.fingerprint];
      if (rule.tags) event.tags = { ...event.tags, ...rule.tags };
      return event;
    },
  });

  Sentry.addEventProcessor(addOtelTraceContextToEvent);
}
