import { warmSharedPostgres } from "../src/sharedPostgres";

const WARMUP_TIMEOUT_MS = 5 * 60_000;

// Startup retries and readiness timeouts do not bound every Docker API call.
setTimeout(() => {
  console.error(`Shared Postgres warm-up timed out after ${WARMUP_TIMEOUT_MS / 1000}s`);
  process.exit(1);
}, WARMUP_TIMEOUT_MS);

warmSharedPostgres().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
