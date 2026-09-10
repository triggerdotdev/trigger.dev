import { describe, it, expect } from "vitest";
import {
  WorkerApiContinueRunExecutionQueryParams,
  WorkerApiRunAttemptCompleteRequestBody,
  WorkerApiRunAttemptStartRequestBody,
  WorkerApiSuspendRunRequestBody,
} from "./schemas.js";

const VALID_ROUTE = {
  version: 1 as const,
  residency: "redis-primary" as const,
  organizationId: "org_123",
};

// A newer worker's route this build cannot read. It must become absent, not fail the request: the
// engine then resolves residency durably. RED before the fix: these bodies used
// SnapshotRouteWire.optional(), whose `version: z.literal(1)` rejected the whole request.
const FUTURE_ROUTE = { version: 2, residency: "redis-primary", organizationId: "org_123" };
const MALFORMED_ROUTES = [
  { version: 1, residency: "nonsense", organizationId: "org_123" },
  { version: 1, organizationId: "org_123" },
  { version: 1, residency: "redis-primary", organizationId: 42 },
  "not-an-object",
  42,
  null,
  [],
];

const COMPLETION = {
  ok: true as const,
  id: "run_123",
  outputType: "application/json",
};

describe("WorkerApiContinueRunExecutionQueryParams", () => {
  it("round-trips snapshotRoute when present", () => {
    const input = {
      snapshotRoute: {
        version: 1 as const,
        residency: "redis-primary" as const,
        organizationId: "org_123",
      },
    };

    const parsed = WorkerApiContinueRunExecutionQueryParams.parse(input);

    expect(parsed.snapshotRoute).toEqual(input.snapshotRoute);
  });

  it("stays valid with snapshotRoute absent (mixed-version)", () => {
    const parsed = WorkerApiContinueRunExecutionQueryParams.parse({});

    expect(parsed.snapshotRoute).toBeUndefined();
  });
});

describe("worker callback bodies accept a snapshotRoute leniently", () => {
  const cases = [
    {
      name: "attempt start",
      schema: WorkerApiRunAttemptStartRequestBody,
      body: (route?: unknown) => ({
        isWarmStart: true,
        ...(route === undefined ? {} : { snapshotRoute: route }),
      }),
      unrelated: { isWarmStart: "yes-please" },
    },
    {
      name: "successful suspend",
      schema: WorkerApiSuspendRunRequestBody,
      body: (route?: unknown) => ({
        success: true,
        checkpoint: { type: "DOCKER", location: "loc", reason: "reason" },
        ...(route === undefined ? {} : { snapshotRoute: route }),
      }),
      unrelated: { success: true, checkpoint: { type: "DOCKER" } },
    },
    {
      name: "attempt completion",
      schema: WorkerApiRunAttemptCompleteRequestBody,
      body: (route?: unknown) => ({
        completion: COMPLETION,
        ...(route === undefined ? {} : { snapshotRoute: route }),
      }),
      unrelated: { completion: { ok: true } },
    },
  ];

  for (const kase of cases) {
    describe(kase.name, () => {
      it("preserves a valid v1 route", () => {
        const parsed = kase.schema.parse(kase.body(VALID_ROUTE));

        expect((parsed as { snapshotRoute?: unknown }).snapshotRoute).toEqual(VALID_ROUTE);
      });

      it("accepts an absent route", () => {
        const parsed = kase.schema.parse(kase.body());

        expect((parsed as { snapshotRoute?: unknown }).snapshotRoute).toBeUndefined();
      });

      it("drops an unknown future route version instead of rejecting the request", () => {
        const parsed = kase.schema.parse(kase.body(FUTURE_ROUTE));

        expect((parsed as { snapshotRoute?: unknown }).snapshotRoute).toBeUndefined();
      });

      it("drops a malformed route instead of rejecting the request", () => {
        for (const malformed of MALFORMED_ROUTES) {
          const parsed = kase.schema.parse(kase.body(malformed));

          expect(
            (parsed as { snapshotRoute?: unknown }).snapshotRoute,
            `malformed route ${JSON.stringify(malformed)} must be dropped`
          ).toBeUndefined();
        }
      });

      it("still rejects a malformed unrelated field", () => {
        expect(kase.schema.safeParse(kase.unrelated).success).toBe(false);
      });
    });
  }
});
