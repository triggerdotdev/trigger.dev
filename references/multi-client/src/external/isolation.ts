/**
 * Isolation smoke test — proves the global `configure()` API and a
 * `new TriggerClient(...)` instance do not leak into each other.
 *
 * Run with:
 *   TRIGGER_GLOBAL_KEY=tr_dev_... \
 *   TRIGGER_INSTANCE_KEY=tr_dev_... \
 *   TRIGGER_INSTANCE_BRANCH=preview-x \
 *   TRIGGER_API_URL=http://localhost:3030 \
 *   pnpm trigger:isolation
 */

import { configure, runs, TriggerClient } from "@trigger.dev/sdk";

const GLOBAL_KEY = process.env.TRIGGER_GLOBAL_KEY;
const INSTANCE_KEY = process.env.TRIGGER_INSTANCE_KEY;
const INSTANCE_BRANCH = process.env.TRIGGER_INSTANCE_BRANCH;

if (!GLOBAL_KEY || !INSTANCE_KEY) {
  console.error(
    "TRIGGER_GLOBAL_KEY and TRIGGER_INSTANCE_KEY env vars are required."
  );
  process.exit(1);
}

const captured: { url: string; auth: string; branch: string | null }[] = [];
const original = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  const headers = new Headers(init?.headers);
  captured.push({
    url,
    auth: headers.get("authorization")?.slice(0, 20) + "..." ?? "(unset)",
    branch: headers.get("x-trigger-branch"),
  });
  return original(input, init);
}) as typeof fetch;

async function main() {
  configure({ accessToken: GLOBAL_KEY! });
  const instance = new TriggerClient({
    accessToken: INSTANCE_KEY!,
    previewBranch: INSTANCE_BRANCH,
  });

  // Global API call (default behavior, reads from configure)
  await runs.list({ limit: 1 }).catch(() => undefined);

  // Instance API call (uses instance config)
  await instance.runs.list({ limit: 1 }).catch(() => undefined);

  // Back-to-back global to confirm no global mutation:
  await runs.list({ limit: 1 }).catch(() => undefined);

  console.log("\nCaptured requests:");
  for (const r of captured) {
    console.log(
      `  auth=${r.auth.padEnd(24)} branch=${(r.branch ?? "(unset)").padEnd(15)} ${truncateUrl(r.url)}`
    );
  }

  const globalAuthPrefix = `Bearer ${GLOBAL_KEY!}`.slice(0, 20) + "...";
  const instanceAuthPrefix = `Bearer ${INSTANCE_KEY!}`.slice(0, 20) + "...";

  const okay = [
    captured[0]?.auth === globalAuthPrefix && captured[0]?.branch === null,
    captured[1]?.auth === instanceAuthPrefix &&
      captured[1]?.branch === (INSTANCE_BRANCH ?? null),
    captured[2]?.auth === globalAuthPrefix && captured[2]?.branch === null,
  ];

  if (okay.every(Boolean)) {
    console.log("\nIsolation verified: global ↔ instance do not leak.");
  } else {
    console.log("\nIsolation check failed. Expected sequence:");
    console.log("  1. global auth, no branch");
    console.log(
      `  2. instance auth, branch=${INSTANCE_BRANCH ?? "(none requested)"}`
    );
    console.log("  3. global auth, no branch");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("script failed:", err);
  process.exit(1);
});

function truncateUrl(url: string): string {
  if (url.length <= 80) return url;
  return url.slice(0, 77) + "...";
}
