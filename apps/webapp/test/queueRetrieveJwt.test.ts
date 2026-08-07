import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The agent reads a queue's live row — paused, depth, limit — through the environment JWT it
 * exchanges its delegated token for. Metrics already answer that JWT; without the same on the
 * retrieve route the agent got a 401, which reaches the model as absent data and had it
 * telling users a queue of thousands of runs did not exist.
 */
const ROUTE = "apps/webapp/app/routes/api.v1.queues.$queueParam.ts";
const METRICS = "apps/webapp/app/routes/api.v1.queues.$queueParam.metrics.ts";

describe("queue retrieve accepts an environment JWT", () => {
  const source = readFileSync(ROUTE, "utf8");

  it("allows the JWT, like its own metrics route does", () => {
    expect(source).toContain("allowJWT: true");
    expect(readFileSync(METRICS, "utf8")).toContain("allowJWT: true");
  });

  it("keeps the queues scope as the gate", () => {
    // Widening who may ask must not widen what they may read.
    expect(source).toContain('resource: () => ({ type: "queues" })');
    expect(source).toContain('action: "read"');
  });
});
