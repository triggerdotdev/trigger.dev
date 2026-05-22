import { describe, expect, vi } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { MollifierBuffer } from "@trigger.dev/redis-worker";
import { RunId } from "@trigger.dev/core/v3/isomorphic";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";
import { resolveRealtimeRunResource } from "~/v3/mollifier/realtimeRunResource.server";

const SNAPSHOT_BASE = {
  friendlyId: "run_phase52e2e",
  taskIdentifier: "hello-world",
  payload: '{"x":1}',
  payloadType: "application/json",
  traceContext: { traceparent: "00-0123456789abcdef0123456789abcdef-fedcba9876543210-01" },
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "fedcba9876543210",
  queue: "task/hello-world",
  tags: ["realtime-e2e"],
  depth: 0,
  isTest: false,
  taskEventStore: "taskEvent",
};

// End-to-end: a real MollifierBuffer has an entry, the real
// readFallback helper deserialises it, and the resolveRealtimeRunResource
// helper produces the resource shape the realtime route returns from
// findResource. Regression intent: if any link in the chain breaks —
// buffer interface rename, snapshot field rename, id-derivation drift,
// synthetic-shape change — this test fails. The route file itself is
// then a thin glue layer over tested pieces.
describe("realtime buffered-subscription resource resolution (testcontainers)", () => {
  redisTest(
    "synthesises a resource whose `id` matches RunId.fromFriendlyId",
    async ({ redisOptions }) => {
      const buffer = new MollifierBuffer({ redisOptions, entryTtlSeconds: 60 });
      try {
        await buffer.accept({
          runId: SNAPSHOT_BASE.friendlyId,
          envId: "env_a",
          orgId: "org_1",
          payload: JSON.stringify(SNAPSHOT_BASE),
        });

        const bufferedSynthetic = await findRunByIdWithMollifierFallback(
          {
            runId: SNAPSHOT_BASE.friendlyId,
            environmentId: "env_a",
            organizationId: "org_1",
          },
          { getBuffer: () => buffer },
        );
        expect(bufferedSynthetic).not.toBeNull();

        const resource = resolveRealtimeRunResource({
          pgRun: null,
          bufferedSynthetic,
        });

        // The load-bearing contract: the resolved `id` MUST equal what
        // engine.trigger will write to PG.TaskRun.id when the drainer
        // materialises this run. Electric's `WHERE id='<id>'` clause
        // depends on this match — drift means a silent-hang regression.
        expect(resource?.id).toBe(RunId.fromFriendlyId(SNAPSHOT_BASE.friendlyId));
        expect(resource?.friendlyId).toBe(SNAPSHOT_BASE.friendlyId);
        expect(resource?.taskIdentifier).toBe("hello-world");
        expect(resource?.runTags).toEqual(["realtime-e2e"]);
        expect(resource?.batch).toBeNull();
        expect(resource?.__bufferedDwellMs).toBeTypeOf("number");
        expect(resource?.__bufferedDwellMs).toBeGreaterThanOrEqual(0);
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "returns null when neither PG nor the buffer have the entry",
    async ({ redisOptions }) => {
      const buffer = new MollifierBuffer({ redisOptions, entryTtlSeconds: 60 });
      try {
        const bufferedSynthetic = await findRunByIdWithMollifierFallback(
          {
            runId: "run_does_not_exist",
            environmentId: "env_a",
            organizationId: "org_1",
          },
          { getBuffer: () => buffer },
        );
        expect(bufferedSynthetic).toBeNull();

        const resource = resolveRealtimeRunResource({
          pgRun: null,
          bufferedSynthetic,
        });
        // The api builder relies on this null to emit a real 404 for
        // genuinely missing runs. If we ever promote unknown runIds to
        // synthetic resources here, the route opens an Electric shape
        // for a run that may never exist — a different silent-hang
        // failure mode for typos, deleted runs, etc.
        expect(resource).toBeNull();
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "does not fall back to buffer when PG has the row",
    async ({ redisOptions }) => {
      const buffer = new MollifierBuffer({ redisOptions, entryTtlSeconds: 60 });
      try {
        await buffer.accept({
          runId: SNAPSHOT_BASE.friendlyId,
          envId: "env_a",
          orgId: "org_1",
          payload: JSON.stringify(SNAPSHOT_BASE),
        });

        // Simulate the drainer having materialised the run: PG has the
        // canonical row, the buffer still has its entry (would be
        // ack'd & removed in real ops). The resolver must return the
        // PG row and NOT carry the __bufferedDwellMs flag — otherwise
        // the loader body would emit a buffered-subscription log for a
        // run that's actually PG-resident, over-counting the signal.
        const pgRun = {
          id: RunId.fromFriendlyId(SNAPSHOT_BASE.friendlyId),
          friendlyId: SNAPSHOT_BASE.friendlyId,
          taskIdentifier: "hello-world",
          runTags: ["realtime-e2e"],
          batch: null,
        };

        const bufferedSynthetic = await findRunByIdWithMollifierFallback(
          {
            runId: SNAPSHOT_BASE.friendlyId,
            environmentId: "env_a",
            organizationId: "org_1",
          },
          { getBuffer: () => buffer },
        );

        const resource = resolveRealtimeRunResource({ pgRun, bufferedSynthetic });
        expect(resource).toEqual(pgRun);
        expect(resource).not.toHaveProperty("__bufferedDwellMs");
      } finally {
        await buffer.close();
      }
    },
  );
});
