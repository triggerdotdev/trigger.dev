// Retry wrapper around `prisma generate`. Our two prisma clients pin the same
// prisma version and so share one package instance in the pnpm store; when
// `turbo run generate` runs them concurrently both race to write the shared
// query-engine binary, and on Windows the loser fails with `EPERM ... rename`.
// Retrying lets it succeed once the engine file is present and unlocked. On
// non-Windows the first attempt succeeds, so this is a zero-cost no-op.
import { spawnSync } from "node:child_process";

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 500;

// Transient, retryable filesystem contention on the shared engine binary.
const TRANSIENT =
  /\b(EPERM|EBUSY|EACCES)\b|operation not permitted|resource busy or locked|being used by another process/i;

const passthroughArgs = process.argv.slice(2);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let lastStatus = 1;

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const result = spawnSync("prisma", ["generate", ...passthroughArgs], {
    shell: true,
    encoding: "utf8",
  });

  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");

  if (result.status === 0) {
    process.exit(0);
  }

  lastStatus = result.status ?? 1;

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const isRetryable = TRANSIENT.test(output);

  if (!isRetryable || attempt === MAX_ATTEMPTS) {
    break;
  }

  const delay = BASE_DELAY_MS * attempt;
  console.error(
    `prisma generate hit a transient filesystem error (attempt ${attempt}/${MAX_ATTEMPTS}); retrying in ${delay}ms...`
  );
  sleepSync(delay);
}

process.exit(lastStatus);
