import "dotenv/config";
import "../sentry.server";
import * as Sentry from "@sentry/remix";

const tag = `filter-test-${Date.now()}`;

const cases = [
  { name: "ServiceValidationError", expect: "DROPPED" },
  { name: "QueueSizeLimitExceededError", expect: "KEPT" },
  { name: "MetadataTooLargeError", expect: "KEPT" },
  { name: "Error", expect: "KEPT" },
];

for (const { name, expect } of cases) {
  const err = new Error(`[FILTER TEST ${tag}] ${name} expect=${expect}`);
  err.name = name;
  Sentry.withScope((scope) => {
    scope.setTag("filter_test", tag);
    scope.setTag("expect", expect);
    Sentry.captureException(err);
  });
}

const ok = await Sentry.flush(10_000);
console.log(`flushed=${ok} tag=${tag}`);
console.log(`Sentry search: https://triggerdev.sentry.io/issues/?query=filter_test%3A${tag}`);
process.exit(0);
