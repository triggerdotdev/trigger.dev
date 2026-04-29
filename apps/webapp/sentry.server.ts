import * as Sentry from "@sentry/remix";

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
  });
}
