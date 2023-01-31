import * as Sentry from "@sentry/remix";
import { env } from "~/env.server";
import { prisma } from "~/db.server";

declare global {
  var __sentry_initialized: boolean;
}

export function init() {
  if (global.__sentry_initialized) {
    return;
  }

  if (!env.SENTRY_DSN) {
    return;
  }

  global.__sentry_initialized = true;

  Sentry.init({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 1,
    integrations: [new Sentry.Integrations.Prisma({ client: prisma })],
    environment: env.APP_ENV,
    maxBreadcrumbs: 50,
    normalizeDepth: 5,
  });

  console.log(`🚦 Sentry initialized in ${env.APP_ENV} mode`);
}
