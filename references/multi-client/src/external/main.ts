/**
 * External multi-client smoke test.
 *
 * Run with:
 *   TRIGGER_PRIMARY_KEY=tr_dev_... \
 *   TRIGGER_SECONDARY_KEY=tr_dev_... \
 *   TRIGGER_SECONDARY_BRANCH=signup-flow \
 *   TRIGGER_API_URL=http://localhost:3030 \
 *   pnpm trigger:external
 *
 * Both clients hit the same backend but with different auth + branch
 * configuration. The fetch interceptor logs every outgoing request's
 * authorization + x-trigger-branch headers so you can visually confirm
 * each client uses its own config and they don't leak into each other.
 */

import { TriggerClient } from "@trigger.dev/sdk";

const PRIMARY_KEY = process.env.TRIGGER_PRIMARY_KEY;
const SECONDARY_KEY = process.env.TRIGGER_SECONDARY_KEY;
const SECONDARY_BRANCH = process.env.TRIGGER_SECONDARY_BRANCH;

if (!PRIMARY_KEY || !SECONDARY_KEY) {
  console.error(
    "TRIGGER_PRIMARY_KEY and TRIGGER_SECONDARY_KEY env vars are required.\n" +
      "Example: TRIGGER_PRIMARY_KEY=tr_dev_xxx TRIGGER_SECONDARY_KEY=tr_dev_yyy pnpm trigger:external"
  );
  process.exit(1);
}

installFetchLogger();

async function main() {
  const primary = new TriggerClient({ accessToken: PRIMARY_KEY! });
  const secondary = new TriggerClient({
    accessToken: SECONDARY_KEY!,
    previewBranch: SECONDARY_BRANCH,
  });

  console.log("\n=== sequential triggers ===\n");
  const sequentialA = await primary.tasks.trigger("echo", {
    from: "primary client (sequential)",
  });
  const sequentialB = await secondary.tasks.trigger("echo", {
    from: "secondary client (sequential)",
  });

  console.log("\nResults:");
  console.log("  primary   ->", sequentialA.id);
  console.log("  secondary ->", sequentialB.id);

  console.log("\n=== concurrent triggers (verifies ALS isolation) ===\n");
  const [c, d, e, f] = await Promise.all([
    primary.tasks.trigger("echo", { from: "primary client (concurrent #1)" }),
    secondary.tasks.trigger("echo", { from: "secondary client (concurrent #1)" }),
    primary.tasks.trigger("echo", { from: "primary client (concurrent #2)" }),
    secondary.tasks.trigger("echo", { from: "secondary client (concurrent #2)" }),
  ]);

  console.log("\nConcurrent results:");
  console.log("  primary   ->", c.id, "/", e.id);
  console.log("  secondary ->", d.id, "/", f.id);

  console.log(
    "\nLook at the fetch log above — every primary request should carry the primary auth header and NO x-trigger-branch,\n" +
      "every secondary request should carry the secondary auth header AND x-trigger-branch when set."
  );
}

main().catch((err) => {
  console.error("script failed:", err);
  process.exit(1);
});

function installFetchLogger() {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input?.url ?? String(input);
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization");
    const branch = headers.get("x-trigger-branch");
    console.log(
      `→ ${init?.method ?? "GET"} ${truncateUrl(url)}\n` +
        `    authorization: ${maskToken(auth)}\n` +
        `    x-trigger-branch: ${branch ?? "(unset)"}`
    );
    return original(input, init);
  }) as typeof fetch;
}

function truncateUrl(url: string): string {
  if (url.length <= 80) return url;
  return url.slice(0, 77) + "...";
}

function maskToken(value: string | null): string {
  if (!value) return "(unset)";
  const prefix = value.slice(0, "Bearer tr_dev_".length + 4);
  return `${prefix}...`;
}
