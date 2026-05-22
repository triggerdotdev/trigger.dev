import { describe, expect, it } from "vitest";
import { BufferEntrySchema, serialiseSnapshot, deserialiseSnapshot } from "./schemas.js";
import { redisTest } from "@internal/testcontainers";
import { Logger } from "@trigger.dev/core/logger";
import { MollifierBuffer } from "./buffer.js";

describe("schemas", () => {
  it("serialiseSnapshot then deserialiseSnapshot is identity for plain objects", () => {
    const snapshot = { taskId: "my-task", payload: { foo: 42, bar: "baz" } };
    const round = deserialiseSnapshot(serialiseSnapshot(snapshot));
    expect(round).toEqual(snapshot);
  });

  it("BufferEntrySchema parses a complete entry", () => {
    const raw = {
      runId: "run_abc",
      envId: "env_1",
      orgId: "org_1",
      payload: serialiseSnapshot({ taskId: "t" }),
      status: "QUEUED",
      attempts: "0",
      createdAt: "2026-05-11T10:00:00.000Z",
      createdAtMicros: "1747044000000000",
    };
    const parsed = BufferEntrySchema.parse(raw);
    expect(parsed.runId).toBe("run_abc");
    expect(parsed.status).toBe("QUEUED");
    expect(parsed.attempts).toBe(0);
    expect(parsed.createdAt).toBeInstanceOf(Date);
    expect(parsed.createdAtMicros).toBe(1747044000000000);
  });

  it("BufferEntrySchema parses a FAILED entry with lastError", () => {
    const raw = {
      runId: "run_abc",
      envId: "env_1",
      orgId: "org_1",
      payload: serialiseSnapshot({}),
      status: "FAILED",
      attempts: "3",
      createdAt: "2026-05-11T10:00:00.000Z",
      createdAtMicros: "1747044000000000",
      lastError: JSON.stringify({ code: "P2024", message: "connection lost" }),
    };
    const parsed = BufferEntrySchema.parse(raw);
    expect(parsed.lastError).toEqual({ code: "P2024", message: "connection lost" });
  });
});

describe("MollifierBuffer construction", () => {
  redisTest("constructs and closes cleanly", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      logger: new Logger("test", "log"),
    });

    await buffer.close();
  });
});

describe("MollifierBuffer.accept", () => {
  redisTest("accept writes entry, enqueues, and tracks env", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      logger: new Logger("test", "log"),
    });

    try {
      await buffer.accept({
        runId: "run_1",
        envId: "env_a",
        orgId: "org_1",
        payload: serialiseSnapshot({ taskId: "t" }),
      });

      const entry = await buffer.getEntry("run_1");
      expect(entry).not.toBeNull();
      expect(entry!.runId).toBe("run_1");
      expect(entry!.envId).toBe("env_a");
      expect(entry!.orgId).toBe("org_1");
      expect(entry!.status).toBe("QUEUED");
      expect(entry!.attempts).toBe(0);
      expect(entry!.createdAt).toBeInstanceOf(Date);

      const envs = await buffer.listEnvsForOrg("org_1");
      expect(envs).toContain("env_a");
    } finally {
      await buffer.close();
    }
  });
});

describe("MollifierBuffer.pop", () => {
  redisTest("pop returns next QUEUED entry and transitions to DRAINING", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      logger: new Logger("test", "log"),
    });

    try {
      await buffer.accept({ runId: "run_1", envId: "env_a", orgId: "org_1", payload: "{}" });
      await buffer.accept({ runId: "run_2", envId: "env_a", orgId: "org_1", payload: "{}" });

      const popped = await buffer.pop("env_a");
      expect(popped).not.toBeNull();
      expect(popped!.runId).toBe("run_1");
      expect(popped!.status).toBe("DRAINING");

      const stored = await buffer.getEntry("run_1");
      expect(stored!.status).toBe("DRAINING");
    } finally {
      await buffer.close();
    }
  });

  redisTest("pop returns null when env queue is empty", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      logger: new Logger("test", "log"),
    });

    try {
      const popped = await buffer.pop("env_nonexistent");
      expect(popped).toBeNull();
    } finally {
      await buffer.close();
    }
  });

  redisTest("atomic RPOP across two parallel pops on the same env", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      logger: new Logger("test", "log"),
    });

    try {
      await buffer.accept({ runId: "only", envId: "env_a", orgId: "org_1", payload: "{}" });

      const [a, b] = await Promise.all([buffer.pop("env_a"), buffer.pop("env_a")]);
      const winners = [a, b].filter((x) => x !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]!.runId).toBe("only");
    } finally {
      await buffer.close();
    }
  });
});

describe("MollifierBuffer.ack", () => {
  redisTest(
    "ack marks entry materialised and applies the grace TTL — entry persists as a read-fallback safety net",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        await buffer.accept({ runId: "run_x", envId: "env_a", orgId: "org_1", payload: "{}" });
        await buffer.pop("env_a");
        await buffer.ack("run_x");

        const after = await buffer.getEntry("run_x");
        expect(after).not.toBeNull();
        expect(after!.materialised).toBe(true);

        // ack grace TTL is the only context where an entry hash gets
        // an EXPIRE — accept no longer sets one. Should be at most 30s.
        const ttl = await buffer.getEntryTtlSeconds("run_x");
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(30);
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest("ack on missing entry is a no-op", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      logger: new Logger("test", "log"),
    });

    try {
      await buffer.ack("run_ghost");
      const stored = await buffer.getEntry("run_ghost");
      expect(stored).toBeNull();
      // Critical: no partial hash created.
      const raw = await buffer["redis"].hgetall("mollifier:entries:run_ghost");
      expect(Object.keys(raw)).toHaveLength(0);
    } finally {
      await buffer.close();
    }
  });
});

describe("MollifierBuffer.pop orphan handling", () => {
  redisTest(
    "pop skips orphan queue references (runId in queue but entry hash expired)",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        // Simulate a TTL-expired orphan: queue ref exists, entry hash does not.
        await buffer["redis"].zadd("mollifier:queue:env_a", 1, "run_orphan");

        const popped = await buffer.pop("env_a");
        expect(popped).toBeNull();

        // Critical: no partial hash was created for the orphan.
        const raw = await buffer["redis"].hgetall("mollifier:entries:run_orphan");
        expect(Object.keys(raw)).toHaveLength(0);

        // Queue is drained — the loop pops orphans until empty.
        const qLen = await buffer["redis"].zcard("mollifier:queue:env_a");
        expect(qLen).toBe(0);
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "pop skips orphans then returns the first valid entry behind them",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        // Layout by score (lowest-first, since ZPOPMIN takes the min):
        // orphan_a (score 1) → valid (score = its createdAtMicros, large) → orphan_b (score 1e18).
        // First pop skips orphan_a, returns valid; orphan_b remains.
        await buffer["redis"].zadd("mollifier:queue:env_a", 1, "orphan_a");
        await buffer.accept({ runId: "valid", envId: "env_a", orgId: "org_1", payload: "{}" });
        await buffer["redis"].zadd("mollifier:queue:env_a", 1e18, "orphan_b");

        const popped = await buffer.pop("env_a");
        expect(popped).not.toBeNull();
        expect(popped!.runId).toBe("valid");
        expect(popped!.status).toBe("DRAINING");

        // The trailing orphan_b is still in the queue (single pop call).
        const remaining = await buffer["redis"].zcard("mollifier:queue:env_a");
        expect(remaining).toBe(1);

        // A second pop drains the trailing orphan_b. The queue is now
        // empty. NOTE: the pop's no-runId branch can't read orgId from
        // a popped entry (it never got one), so it doesn't prune the
        // org-envs SET. env_a remains in `mollifier:org-envs:org_1` as
        // a stale entry until the next accept-or-success-pop cycle
        // recovers it. This is the deliberate trade-off documented in
        // popAndMarkDraining's Lua.
        const second = await buffer.pop("env_a");
        expect(second).toBeNull();
      } finally {
        await buffer.close();
      }
    },
  );
});

describe("MollifierBuffer.requeue", () => {
  redisTest("requeue increments attempts, restores QUEUED, re-LPUSHes", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      logger: new Logger("test", "log"),
    });

    try {
      await buffer.accept({ runId: "run_r", envId: "env_a", orgId: "org_1", payload: "{}" });
      await buffer.pop("env_a");
      await buffer.requeue("run_r");

      const entry = await buffer.getEntry("run_r");
      expect(entry!.status).toBe("QUEUED");
      expect(entry!.attempts).toBe(1);

      const popped = await buffer.pop("env_a");
      expect(popped!.runId).toBe("run_r");
    } finally {
      await buffer.close();
    }
  });
});

describe("MollifierBuffer.fail", () => {
  redisTest(
    "fail returns true and tears the entry down (drainer-terminal cleanup)",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      // Post-TTL-drop design: the drainer's createFailedTaskRun has
      // already written a SYSTEM_FAILURE PG row by the time we call
      // fail(), so the entry hash is no longer load-bearing. fail
      // returns true and removes the entry; without this teardown
      // failed entries would accrete forever now that there's no
      // accept-time TTL. The Lua also DELs the idempotency lookup so
      // future retries with the same key go through to PG instead of
      // hitting an orphan dedup record.
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        await buffer.accept({ runId: "run_f", envId: "env_a", orgId: "org_1", payload: "{}" });
        await buffer.pop("env_a");
        const failed = await buffer.fail("run_f", { code: "VALIDATION", message: "boom" });
        expect(failed).toBe(true);

        // Entry hash is gone post-fail.
        const entry = await buffer.getEntry("run_f");
        expect(entry).toBeNull();
        const raw = await buffer["redis"].hgetall("mollifier:entries:run_f");
        expect(Object.keys(raw)).toHaveLength(0);
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "fail on missing entry is a no-op (returns false; no partial hash created)",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        const result = await buffer.fail("run_ghost", { code: "VALIDATION", message: "boom" });
        expect(result).toBe(false);

        // Critical: no partial entry hash was created.
        const stored = await buffer.getEntry("run_ghost");
        expect(stored).toBeNull();
        const raw = await buffer["redis"].hgetall("mollifier:entries:run_ghost");
        expect(Object.keys(raw)).toHaveLength(0);
      } finally {
        await buffer.close();
      }
    },
  );
});

describe("MollifierBuffer TTL", () => {
  redisTest(
    "entry has NO TTL applied on accept — drainer is the only cleanup path",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      // Regression guard for the design change: buffer entries must
      // persist until the drainer ACKs or FAILs them. An accept-time
      // EXPIRE would re-introduce the silent-loss-when-drainer-offline
      // failure mode that the stale-entry alerting pipeline depends on
      // *not* happening.
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        await buffer.accept({ runId: "run_t", envId: "env_a", orgId: "org_1", payload: "{}" });

        // Redis returns -1 when the key exists but has no TTL set.
        const ttl = await buffer.getEntryTtlSeconds("run_t");
        expect(ttl).toBe(-1);
      } finally {
        await buffer.close();
      }
    },
  );
});

describe("MollifierBuffer payload encoding", () => {
  redisTest(
    "pop round-trips payloads with quotes, backslashes, control chars, unicode",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      const tricky = {
        quotes: 'a"b\'c',
        backslash: "x\\y\\z",
        newlines: "line1\nline2\r\nline3",
        tab: "col1\tcol2",
        unicode: "héllo 🦀 世界",
        lineSep: "before after end",
        nested: { arr: ["a", "b", 1, true, null], n: 3.14 },
      };
      const payload = serialiseSnapshot(tricky);

      try {
        await buffer.accept({ runId: "tricky", envId: "env_a", orgId: "org_1", payload });

        const popped = await buffer.pop("env_a");
        expect(popped).not.toBeNull();
        expect(popped!.payload).toBe(payload);

        const decoded = JSON.parse(popped!.payload);
        expect(decoded).toEqual(tricky);
      } finally {
        await buffer.close();
      }
    },
  );
});

describe("MollifierBuffer.requeue on missing entry", () => {
  redisTest(
    "requeue on a non-existent runId is a no-op (Lua returns 0; no queue push)",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        await buffer.requeue("run_does_not_exist");

        // Critical: no queue keys were created from this no-op requeue.
        const queueKeys = await buffer["redis"].keys("mollifier:queue:*");
        expect(queueKeys).toHaveLength(0);
        const envs = await buffer.listEnvsForOrg("org_1");
        expect(envs).toHaveLength(0);
      } finally {
        await buffer.close();
      }
    },
  );
});

describe("MollifierBuffer.requeue ordering", () => {
  redisTest(
    "requeued entry retains its original createdAt and pops next (oldest-first by createdAt)",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      // Score == createdAtMicros; requeue does not bump the score. The
      // oldest entry continues to pop first across retries. `maxAttempts`
      // in the drainer bounds the retry loop for a persistently failing
      // entry (after which it goes to the `fail` path, not requeue).
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        await buffer.accept({ runId: "a", envId: "env_a", orgId: "org_1", payload: "{}" });
        await new Promise((r) => setTimeout(r, 2));
        await buffer.accept({ runId: "b", envId: "env_a", orgId: "org_1", payload: "{}" });
        await new Promise((r) => setTimeout(r, 2));
        await buffer.accept({ runId: "c", envId: "env_a", orgId: "org_1", payload: "{}" });

        const first = await buffer.pop("env_a");
        expect(first!.runId).toBe("a");

        await buffer.requeue("a");

        // a still has the smallest createdAtMicros → pops next.
        const next = await buffer.pop("env_a");
        expect(next!.runId).toBe("a");
        const after = await buffer.pop("env_a");
        expect(after!.runId).toBe("b");
        const last = await buffer.pop("env_a");
        expect(last!.runId).toBe("c");
      } finally {
        await buffer.close();
      }
    },
  );
});

describe("MollifierBuffer.evaluateTrip", () => {
  const tripOptions = {
    windowMs: 200,
    threshold: 5,
    holdMs: 100,
  };

  redisTest("under threshold: not tripped, count increments", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      logger: new Logger("test", "log"),
    });

    try {
      const r1 = await buffer.evaluateTrip("env_a", tripOptions);
      expect(r1).toEqual({ tripped: false, count: 1 });

      const r2 = await buffer.evaluateTrip("env_a", tripOptions);
      expect(r2).toEqual({ tripped: false, count: 2 });
    } finally {
      await buffer.close();
    }
  });

  redisTest("crossing threshold sets the tripped marker", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      logger: new Logger("test", "log"),
    });

    try {
      for (let i = 0; i < 5; i++) {
        const r = await buffer.evaluateTrip("env_a", tripOptions);
        expect(r.tripped).toBe(false);
      }

      const after = await buffer.evaluateTrip("env_a", tripOptions);
      expect(after).toEqual({ tripped: true, count: 6 });

      const sticky = await buffer.evaluateTrip("env_a", tripOptions);
      expect(sticky.tripped).toBe(true);
    } finally {
      await buffer.close();
    }
  });

  redisTest("hold-down marker expires after holdMs and env resets", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      logger: new Logger("test", "log"),
    });

    try {
      const fastWindow = { windowMs: 100, threshold: 2, holdMs: 100 };
      await buffer.evaluateTrip("env_a", fastWindow);
      await buffer.evaluateTrip("env_a", fastWindow);
      const tripped = await buffer.evaluateTrip("env_a", fastWindow);
      expect(tripped.tripped).toBe(true);

      // Wait past windowMs AND holdMs so both rate counter and tripped marker expire
      await new Promise((r) => setTimeout(r, 220));

      const recovered = await buffer.evaluateTrip("env_a", fastWindow);
      expect(recovered).toEqual({ tripped: false, count: 1 });
    } finally {
      await buffer.close();
    }
  });

  redisTest("env isolation: tripping env_a does not affect env_b", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      logger: new Logger("test", "log"),
    });

    try {
      for (let i = 0; i < 6; i++) {
        await buffer.evaluateTrip("env_a", tripOptions);
      }
      const aTripped = await buffer.evaluateTrip("env_a", tripOptions);
      expect(aTripped.tripped).toBe(true);

      const b = await buffer.evaluateTrip("env_b", tripOptions);
      expect(b).toEqual({ tripped: false, count: 1 });
    } finally {
      await buffer.close();
    }
  });

  redisTest("window expires and counter resets when no traffic", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      logger: new Logger("test", "log"),
    });

    try {
      const fastWindow = { windowMs: 100, threshold: 100, holdMs: 100 };
      await buffer.evaluateTrip("env_x", fastWindow);
      await buffer.evaluateTrip("env_x", fastWindow);
      // both incremented within a fresh window — count should be 2

      await new Promise((r) => setTimeout(r, 150));
      const fresh = await buffer.evaluateTrip("env_x", fastWindow);
      expect(fresh.count).toBe(1);
    } finally {
      await buffer.close();
    }
  });

  redisTest(
    "tripped marker outlives the rate counter window",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        const opts = { windowMs: 50, threshold: 2, holdMs: 1000 };
        await buffer.evaluateTrip("env_a", opts);
        await buffer.evaluateTrip("env_a", opts);
        const tripped = await buffer.evaluateTrip("env_a", opts);
        expect(tripped.tripped).toBe(true);

        // Wait past windowMs (rate counter expires) but well inside holdMs (marker persists).
        await new Promise((r) => setTimeout(r, 120));

        const after = await buffer.evaluateTrip("env_a", opts);
        expect(after.tripped).toBe(true);
        expect(after.count).toBeLessThanOrEqual(2);
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "INCR is atomic under 100 concurrent calls (no lost increments)",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        // Wide window so all 100 calls land in the same window. High threshold
        // so trip semantics don't interfere with the count assertion.
        const opts = { windowMs: 5000, threshold: 1_000_000, holdMs: 100 };
        const results = await Promise.all(
          Array.from({ length: 100 }, () => buffer.evaluateTrip("env_atomic", opts)),
        );

        // Every return value is unique (no two callers saw the same INCR result).
        const counts = results.map((r) => r.count).sort((a, b) => a - b);
        expect(counts).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));

        // No call tripped (we set threshold absurdly high).
        expect(results.every((r) => !r.tripped)).toBe(true);
      } finally {
        await buffer.close();
      }
    },
  );
});

describe("MollifierBuffer entry lifecycle invariants", () => {
  redisTest(
    "entry TTL is preserved across pop (DRAINING entries don't lose their TTL)",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        await buffer.accept({ runId: "run_ttl", envId: "env_a", orgId: "org_1", payload: "{}" });
        const beforeTtl = await buffer.getEntryTtlSeconds("run_ttl");
        expect(beforeTtl).toBe(-1);

        await buffer.pop("env_a");
        const afterTtl = await buffer.getEntryTtlSeconds("run_ttl");

        // No TTL applied at any point during accept/pop — the entry
        // persists until the drainer ACKs or FAILs. Returning -1 from
        // Redis here is the expected steady state, not a leak.
        expect(afterTtl).toBe(-1);
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "envs set membership tracks queue+DRAINING presence across the full lifecycle",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        // Empty start
        expect(await buffer.listEnvsForOrg("org_1")).not.toContain("env_lc");

        // accept → SADD
        await buffer.accept({ runId: "r1", envId: "env_lc", orgId: "org_1", payload: "{}" });
        expect(await buffer.listEnvsForOrg("org_1")).toContain("env_lc");

        // second accept (different runId) → still SADD (idempotent)
        await buffer.accept({ runId: "r2", envId: "env_lc", orgId: "org_1", payload: "{}" });
        expect(await buffer.listEnvsForOrg("org_1")).toContain("env_lc");

        // pop r1 → queue still has r2 → env stays
        await buffer.pop("env_lc");
        expect(await buffer.listEnvsForOrg("org_1")).toContain("env_lc");

        // ack r1 → no queue change, env still tracked (r2 still queued)
        await buffer.ack("r1");
        expect(await buffer.listEnvsForOrg("org_1")).toContain("env_lc");

        // pop r2 → queue empties → SREM
        await buffer.pop("env_lc");
        expect(await buffer.listEnvsForOrg("org_1")).not.toContain("env_lc");

        // requeue r2 → SADD back
        await buffer.requeue("r2");
        expect(await buffer.listEnvsForOrg("org_1")).toContain("env_lc");

        // fail r2 → entry FAILED but queue empty → next pop should SREM
        await buffer.pop("env_lc");
        await buffer.fail("r2", { code: "X", message: "boom" });
        const afterFailEnvs = await buffer.listEnvsForOrg("org_1");
        // Queue is empty, env was SREM'd by the pop above.
        expect(afterFailEnvs).not.toContain("env_lc");
      } finally {
        await buffer.close();
      }
    },
  );
});

describe("MollifierBuffer.accept idempotency", () => {
  redisTest(
    "duplicate runId is refused; queue not double-LPUSHed; existing entry not overwritten",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        const first = await buffer.accept({
          runId: "run_dup",
          envId: "env_a",
          orgId: "org_1",
          payload: serialiseSnapshot({ first: true }),
        });
        const second = await buffer.accept({
          runId: "run_dup",
          envId: "env_a",
          orgId: "org_1",
          payload: serialiseSnapshot({ first: false }),
        });

        expect(first).toEqual({ kind: "accepted" });
        expect(second).toEqual({ kind: "duplicate_run_id" });

        // First payload preserved; second was a no-op.
        const stored = await buffer.getEntry("run_dup");
        expect(stored).not.toBeNull();
        const decoded = JSON.parse(stored!.payload);
        expect(decoded).toEqual({ first: true });

        // Exactly one queue entry, not two.
        const popped1 = await buffer.pop("env_a");
        expect(popped1).not.toBeNull();
        expect(popped1!.runId).toBe("run_dup");
        const popped2 = await buffer.pop("env_a");
        expect(popped2).toBeNull();
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "accept refused while existing entry is DRAINING",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        await buffer.accept({ runId: "run_dr", envId: "env_a", orgId: "org_1", payload: "{}" });
        await buffer.pop("env_a"); // now DRAINING
        const stored = await buffer.getEntry("run_dr");
        expect(stored!.status).toBe("DRAINING");

        const dup = await buffer.accept({ runId: "run_dr", envId: "env_a", orgId: "org_1", payload: "{}" });
        expect(dup).toEqual({ kind: "duplicate_run_id" });

        const afterDup = await buffer.getEntry("run_dr");
        expect(afterDup!.status).toBe("DRAINING"); // unchanged
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "runId slot is reclaimable after fail tears the entry down",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      // Post-TTL-drop design: fail() deletes the entry hash because
      // the SYSTEM_FAILURE PG row is the canonical record of the
      // failure. The runId slot is therefore free for a fresh accept
      // afterwards — runIds are server-generated CUIDs and don't
      // collide in practice, but the contract pinning here documents
      // that a re-acceptance does NOT see a phantom "FAILED" entry.
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        await buffer.accept({ runId: "run_fl", envId: "env_a", orgId: "org_1", payload: "{}" });
        await buffer.pop("env_a");
        await buffer.fail("run_fl", { code: "VALIDATION", message: "boom" });

        // Entry hash gone after fail (see "fail returns true and tears
        // the entry down" — this test pins the accept-side effect).
        expect(await buffer.getEntry("run_fl")).toBeNull();

        const fresh = await buffer.accept({
          runId: "run_fl",
          envId: "env_a",
          orgId: "org_1",
          payload: '{"fresh":true}',
        });
        expect(fresh).toEqual({ kind: "accepted" });
        const after = await buffer.getEntry("run_fl");
        expect(after?.status).toBe("QUEUED");
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "accept refused while a previously-acked (materialised) entry is still inside its grace TTL",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      // After ack, the entry hash persists for the grace window as a
      // read-fallback safety net (Q1 D2). RunIds are server-generated and
      // never collide in practice, but defense-in-depth: accept refuses
      // while *any* entry exists for the runId, including materialised
      // ones. The entry hash's TTL is now ~30s instead of the original
      // entryTtlSeconds.
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        const first = await buffer.accept({
          runId: "run_x",
          envId: "env_a",
          orgId: "org_1",
          payload: "{}",
        });
        await buffer.pop("env_a");
        await buffer.ack("run_x");

        const reAccept = await buffer.accept({
          runId: "run_x",
          envId: "env_a",
          orgId: "org_1",
          payload: "{}",
        });

        expect(first).toEqual({ kind: "accepted" });
        expect(reAccept).toEqual({ kind: "duplicate_run_id" });

        const stored = await buffer.getEntry("run_x");
        expect(stored!.materialised).toBe(true);
      } finally {
        await buffer.close();
      }
    },
  );
});

describe("MollifierBuffer envs set lifecycle", () => {
  redisTest(
    "pop SREMs envId when it drains the queue",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        await buffer.accept({ runId: "r1", envId: "env_a", orgId: "org_1", payload: "{}" });
        expect(await buffer.listEnvsForOrg("org_1")).toContain("env_a");

        await buffer.pop("env_a");
        expect(await buffer.listEnvsForOrg("org_1")).not.toContain("env_a");
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "pop keeps envId in set while items remain; SREMs only on the draining pop",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        await buffer.accept({ runId: "r1", envId: "env_a", orgId: "org_1", payload: "{}" });
        await buffer.accept({ runId: "r2", envId: "env_a", orgId: "org_1", payload: "{}" });
        expect(await buffer.listEnvsForOrg("org_1")).toContain("env_a");

        await buffer.pop("env_a");
        expect(await buffer.listEnvsForOrg("org_1")).toContain("env_a");

        await buffer.pop("env_a");
        expect(await buffer.listEnvsForOrg("org_1")).not.toContain("env_a");
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "requeue re-SADDs the envId if pop had previously cleaned it",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        await buffer.accept({ runId: "r1", envId: "env_a", orgId: "org_1", payload: "{}" });
        await buffer.pop("env_a");
        // Queue drained → env_a SREM'd.
        expect(await buffer.listEnvsForOrg("org_1")).not.toContain("env_a");

        await buffer.requeue("r1");
        // requeue must put env_a back so the drainer notices the retry.
        expect(await buffer.listEnvsForOrg("org_1")).toContain("env_a");
      } finally {
        await buffer.close();
      }
    },
  );
});

describe("MollifierBuffer idempotency lookup", () => {
  redisTest(
    "accept with idempotencyKey + taskIdentifier writes the lookup with no TTL",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      // Post-TTL-drop design: the idempotency lookup has no TTL, so it
      // can never expire ahead of the entry hash (which used to cause
      // a dedup-drift bug — once the lookup expired but the entry
      // didn't, a retry with the same key would create a *new*
      // buffered run for the same key). The drainer's ack and fail
      // both DEL the lookup as part of teardown.
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        const result = await buffer.accept({
          runId: "ri1",
          envId: "env_i",
          orgId: "org_1",
          payload: "{}",
          idempotencyKey: "ikey-1",
          taskIdentifier: "my-task",
        });
        expect(result).toEqual({ kind: "accepted" });

        const lookupKey = "mollifier:idempotency:env_i:my-task:ikey-1";
        const stored = await buffer["redis"].get(lookupKey);
        expect(stored).toBe("ri1");
        // -1 = key exists with no TTL set.
        expect(await buffer["redis"].ttl(lookupKey)).toBe(-1);

        const entry = await buffer.getEntry("ri1");
        expect(entry!.idempotencyLookupKey).toBe(lookupKey);
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "second accept with same (env, task, idempotencyKey) returns duplicate_idempotency with the winner's runId",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        const first = await buffer.accept({
          runId: "ri-a",
          envId: "env_i",
          orgId: "org_1",
          payload: "{}",
          idempotencyKey: "ikey-2",
          taskIdentifier: "my-task",
        });
        const second = await buffer.accept({
          runId: "ri-b",
          envId: "env_i",
          orgId: "org_1",
          payload: "{}",
          idempotencyKey: "ikey-2",
          taskIdentifier: "my-task",
        });

        expect(first).toEqual({ kind: "accepted" });
        expect(second).toEqual({
          kind: "duplicate_idempotency",
          existingRunId: "ri-a",
        });

        // The loser's runId entry was never created.
        const loserEntry = await buffer.getEntry("ri-b");
        expect(loserEntry).toBeNull();
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "lookupIdempotency hits when the run is buffered",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        await buffer.accept({
          runId: "rl1",
          envId: "env_i",
          orgId: "org_1",
          payload: "{}",
          idempotencyKey: "k1",
          taskIdentifier: "t",
        });
        const found = await buffer.lookupIdempotency({
          envId: "env_i",
          taskIdentifier: "t",
          idempotencyKey: "k1",
        });
        expect(found).toBe("rl1");
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "lookupIdempotency returns null when no lookup is bound",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        const found = await buffer.lookupIdempotency({
          envId: "env_i",
          taskIdentifier: "t",
          idempotencyKey: "absent",
        });
        expect(found).toBeNull();
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "lookupIdempotency self-heals when the lookup points at an expired entry",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        // Plant a stale lookup pointing at a non-existent entry.
        const lookupKey = "mollifier:idempotency:env_i:t:stale";
        await buffer["redis"].set(lookupKey, "rl-stale", "EX", 600);
        expect(await buffer["redis"].get(lookupKey)).toBe("rl-stale");

        const found = await buffer.lookupIdempotency({
          envId: "env_i",
          taskIdentifier: "t",
          idempotencyKey: "stale",
        });
        expect(found).toBeNull();
        // Self-healed.
        expect(await buffer["redis"].get(lookupKey)).toBeNull();
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "ack DELs the idempotency lookup along with marking materialised",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        await buffer.accept({
          runId: "ra1",
          envId: "env_i",
          orgId: "org_1",
          payload: "{}",
          idempotencyKey: "ka",
          taskIdentifier: "t",
        });
        await buffer.pop("env_i");
        await buffer.ack("ra1");

        const lookupKey = "mollifier:idempotency:env_i:t:ka";
        expect(await buffer["redis"].get(lookupKey)).toBeNull();
        const entry = await buffer.getEntry("ra1");
        expect(entry!.materialised).toBe(true);
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "resetIdempotency clears snapshot fields + lookup; returns the runId",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        await buffer.accept({
          runId: "rr1",
          envId: "env_i",
          orgId: "org_1",
          payload: serialiseSnapshot({
            idempotencyKey: "kr",
            idempotencyKeyExpiresAt: "2026-12-01T00:00:00Z",
            other: "field",
          }),
          idempotencyKey: "kr",
          taskIdentifier: "t",
        });

        const result = await buffer.resetIdempotency({
          envId: "env_i",
          taskIdentifier: "t",
          idempotencyKey: "kr",
        });
        expect(result.clearedRunId).toBe("rr1");

        // Lookup is gone.
        const lookupKey = "mollifier:idempotency:env_i:t:kr";
        expect(await buffer["redis"].get(lookupKey)).toBeNull();

        // Snapshot's idempotency fields are nulled, other fields kept.
        const entry = await buffer.getEntry("rr1");
        const payload = JSON.parse(entry!.payload) as {
          idempotencyKey: unknown;
          idempotencyKeyExpiresAt: unknown;
          other: string;
        };
        expect(payload.idempotencyKey).toBeNull();
        expect(payload.idempotencyKeyExpiresAt).toBeNull();
        expect(payload.other).toBe("field");
        expect(entry!.idempotencyLookupKey).toBe("");
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "resetIdempotency returns null when nothing is bound",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        const result = await buffer.resetIdempotency({
          envId: "env_i",
          taskIdentifier: "t",
          idempotencyKey: "absent",
        });
        expect(result.clearedRunId).toBeNull();
      } finally {
        await buffer.close();
      }
    },
  );
});

describe("MollifierBuffer.casSetMetadata", () => {
  redisTest(
    "applies when expectedVersion matches; increments version; updates payload",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        await buffer.accept({
          runId: "cas1",
          envId: "env_c",
          orgId: "org_1",
          payload: serialiseSnapshot({ metadata: '{"v":1}', metadataType: "application/json" }),
        });
        const result = await buffer.casSetMetadata({
          runId: "cas1",
          expectedVersion: 0,
          newMetadata: '{"v":2}',
          newMetadataType: "application/json",
        });
        expect(result).toEqual({ kind: "applied", newVersion: 1 });

        const entry = await buffer.getEntry("cas1");
        expect(entry!.metadataVersion).toBe(1);
        const payload = JSON.parse(entry!.payload) as { metadata: string };
        expect(payload.metadata).toBe('{"v":2}');
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "returns version_conflict when expectedVersion is stale",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        await buffer.accept({
          runId: "cas2",
          envId: "env_c",
          orgId: "org_1",
          payload: serialiseSnapshot({}),
        });
        await buffer.casSetMetadata({
          runId: "cas2",
          expectedVersion: 0,
          newMetadata: '{"a":1}',
          newMetadataType: "application/json",
        });

        // Second write with stale expectedVersion = 0 must conflict.
        const result = await buffer.casSetMetadata({
          runId: "cas2",
          expectedVersion: 0,
          newMetadata: '{"a":2}',
          newMetadataType: "application/json",
        });
        expect(result).toEqual({ kind: "version_conflict", currentVersion: 1 });
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "returns not_found / busy on missing or terminal entries",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        const nf = await buffer.casSetMetadata({
          runId: "absent",
          expectedVersion: 0,
          newMetadata: "{}",
          newMetadataType: "application/json",
        });
        expect(nf).toEqual({ kind: "not_found" });

        await buffer.accept({
          runId: "cas3",
          envId: "env_c",
          orgId: "org_1",
          payload: serialiseSnapshot({}),
        });
        await buffer.pop("env_c");
        const busy = await buffer.casSetMetadata({
          runId: "cas3",
          expectedVersion: 0,
          newMetadata: "{}",
          newMetadataType: "application/json",
        });
        expect(busy).toEqual({ kind: "busy" });
      } finally {
        await buffer.close();
      }
    },
  );
});

describe("MollifierBuffer.mutateSnapshot", () => {
  redisTest(
    "returns not_found when no entry exists for the runId",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        const result = await buffer.mutateSnapshot("nope", {
          type: "append_tags",
          tags: ["x"],
        });
        expect(result).toBe("not_found");
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "append_tags on QUEUED entry appends and dedupes",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        await buffer.accept({
          runId: "r1",
          envId: "env_m",
          orgId: "org_1",
          payload: serialiseSnapshot({ tags: ["existing"] }),
        });
        const first = await buffer.mutateSnapshot("r1", {
          type: "append_tags",
          tags: ["existing", "new"],
        });
        expect(first).toBe("applied_to_snapshot");

        const entry = await buffer.getEntry("r1");
        const payload = JSON.parse(entry!.payload) as { tags: string[] };
        expect(payload.tags).toEqual(["existing", "new"]);

        // Second mutation appends without duplicating
        const second = await buffer.mutateSnapshot("r1", {
          type: "append_tags",
          tags: ["new", "third"],
        });
        expect(second).toBe("applied_to_snapshot");
        const e2 = await buffer.getEntry("r1");
        const p2 = JSON.parse(e2!.payload) as { tags: string[] };
        expect(p2.tags).toEqual(["existing", "new", "third"]);
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "append_tags creates payload.tags when absent",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        await buffer.accept({
          runId: "r2",
          envId: "env_m",
          orgId: "org_1",
          payload: serialiseSnapshot({ taskId: "t" }),
        });
        const result = await buffer.mutateSnapshot("r2", {
          type: "append_tags",
          tags: ["a", "b"],
        });
        expect(result).toBe("applied_to_snapshot");
        const entry = await buffer.getEntry("r2");
        const payload = JSON.parse(entry!.payload) as { tags: string[] };
        expect(payload.tags).toEqual(["a", "b"]);
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "set_metadata replaces metadata + metadataType (last-write-wins)",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        await buffer.accept({
          runId: "r3",
          envId: "env_m",
          orgId: "org_1",
          payload: serialiseSnapshot({ metadata: '{"v":1}', metadataType: "application/json" }),
        });
        const result = await buffer.mutateSnapshot("r3", {
          type: "set_metadata",
          metadata: '{"v":2}',
          metadataType: "application/json",
        });
        expect(result).toBe("applied_to_snapshot");
        const entry = await buffer.getEntry("r3");
        const payload = JSON.parse(entry!.payload) as {
          metadata: string;
          metadataType: string;
        };
        expect(payload.metadata).toBe('{"v":2}');
        expect(payload.metadataType).toBe("application/json");
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "set_delay sets payload.delayUntil",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        await buffer.accept({
          runId: "r4",
          envId: "env_m",
          orgId: "org_1",
          payload: serialiseSnapshot({ taskId: "t" }),
        });
        const result = await buffer.mutateSnapshot("r4", {
          type: "set_delay",
          delayUntil: "2026-06-01T00:00:00.000Z",
        });
        expect(result).toBe("applied_to_snapshot");
        const entry = await buffer.getEntry("r4");
        const payload = JSON.parse(entry!.payload) as { delayUntil: string };
        expect(payload.delayUntil).toBe("2026-06-01T00:00:00.000Z");
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "mark_cancelled stamps cancelledAt + cancelReason",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        await buffer.accept({
          runId: "r5",
          envId: "env_m",
          orgId: "org_1",
          payload: serialiseSnapshot({ taskId: "t" }),
        });
        const result = await buffer.mutateSnapshot("r5", {
          type: "mark_cancelled",
          cancelledAt: "2026-05-19T12:00:00.000Z",
          cancelReason: "user-initiated",
        });
        expect(result).toBe("applied_to_snapshot");
        const entry = await buffer.getEntry("r5");
        const payload = JSON.parse(entry!.payload) as {
          cancelledAt: string;
          cancelReason: string;
        };
        expect(payload.cancelledAt).toBe("2026-05-19T12:00:00.000Z");
        expect(payload.cancelReason).toBe("user-initiated");
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "returns busy when entry is DRAINING",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        await buffer.accept({
          runId: "rd",
          envId: "env_m",
          orgId: "org_1",
          payload: serialiseSnapshot({ tags: [] }),
        });
        await buffer.pop("env_m");
        const result = await buffer.mutateSnapshot("rd", {
          type: "append_tags",
          tags: ["x"],
        });
        expect(result).toBe("busy");
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "returns not_found when entry was FAILED (drainer-terminal teardown)",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      // Post-TTL-drop design: fail() DELs the entry hash because the
      // drainer has already written the canonical SYSTEM_FAILURE PG
      // row, and without an accept-time TTL we'd otherwise accrete
      // failed entries in Redis forever. Late mutations against a
      // failed run therefore see `not_found`, matching the same shape
      // they'd get for any other already-cleaned-up runId.
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        await buffer.accept({
          runId: "rf",
          envId: "env_m",
          orgId: "org_1",
          payload: serialiseSnapshot({ tags: [] }),
        });
        await buffer.pop("env_m");
        await buffer.fail("rf", { code: "X", message: "boom" });
        const result = await buffer.mutateSnapshot("rf", {
          type: "append_tags",
          tags: ["x"],
        });
        expect(result).toBe("not_found");
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "returns busy when entry is materialised (post-ack grace window)",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        await buffer.accept({
          runId: "rm",
          envId: "env_m",
          orgId: "org_1",
          payload: serialiseSnapshot({ tags: [] }),
        });
        await buffer.pop("env_m");
        await buffer.ack("rm");
        const result = await buffer.mutateSnapshot("rm", {
          type: "append_tags",
          tags: ["x"],
        });
        expect(result).toBe("busy");
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "Lua atomicity serialises concurrent mutations per-runId",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        await buffer.accept({
          runId: "rcc",
          envId: "env_m",
          orgId: "org_1",
          payload: serialiseSnapshot({ tags: [] }),
        });

        const tagsToAdd = Array.from({ length: 50 }, (_, i) => `t${i}`);
        await Promise.all(
          tagsToAdd.map((t) => buffer.mutateSnapshot("rcc", { type: "append_tags", tags: [t] })),
        );

        const entry = await buffer.getEntry("rcc");
        const payload = JSON.parse(entry!.payload) as { tags: string[] };
        expect(payload.tags.sort()).toEqual(tagsToAdd.sort());
      } finally {
        await buffer.close();
      }
    },
  );
});

describe("MollifierBuffer ZSET storage", () => {
  redisTest(
    "queue key is a ZSET scored by entry's createdAtMicros",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        await buffer.accept({ runId: "z1", envId: "env_z", orgId: "org_1", payload: "{}" });

        // ZSET-only commands must succeed against the queue key.
        const card = await buffer["redis"].zcard("mollifier:queue:env_z");
        expect(card).toBe(1);

        const score = await buffer["redis"].zscore("mollifier:queue:env_z", "z1");
        expect(score).not.toBeNull();
        const scoreNum = Number(score);
        expect(Number.isFinite(scoreNum)).toBe(true);

        // Score matches the entry hash's createdAtMicros field.
        const micros = await buffer["redis"].hget("mollifier:entries:z1", "createdAtMicros");
        expect(micros).not.toBeNull();
        expect(Number(micros)).toBe(scoreNum);

        // Score is plausibly recent (within last minute as microseconds).
        const nowMicros = Date.now() * 1000;
        expect(scoreNum).toBeGreaterThan(nowMicros - 60_000_000);
        expect(scoreNum).toBeLessThanOrEqual(nowMicros + 1_000_000);
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "pop returns entries in ascending createdAtMicros order (FIFO by time, not by member)",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        // Insert runIds in reverse-lex order to prove ordering is by score, not member.
        await buffer.accept({ runId: "zzz", envId: "env_o", orgId: "org_1", payload: "{}" });
        await new Promise((r) => setTimeout(r, 5));
        await buffer.accept({ runId: "mmm", envId: "env_o", orgId: "org_1", payload: "{}" });
        await new Promise((r) => setTimeout(r, 5));
        await buffer.accept({ runId: "aaa", envId: "env_o", orgId: "org_1", payload: "{}" });

        const first = await buffer.pop("env_o");
        expect(first!.runId).toBe("zzz");
        const second = await buffer.pop("env_o");
        expect(second!.runId).toBe("mmm");
        const third = await buffer.pop("env_o");
        expect(third!.runId).toBe("aaa");
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "requeue keeps original score; createdAt is immutable across retries",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        await buffer.accept({ runId: "rq", envId: "env_rq", orgId: "org_1", payload: "{}" });
        const originalScore = Number(
          await buffer["redis"].zscore("mollifier:queue:env_rq", "rq"),
        );
        const originalMicros = Number(
          await buffer["redis"].hget("mollifier:entries:rq", "createdAtMicros"),
        );

        await buffer.pop("env_rq");
        await new Promise((r) => setTimeout(r, 5));
        await buffer.requeue("rq");

        const newScore = Number(
          await buffer["redis"].zscore("mollifier:queue:env_rq", "rq"),
        );
        const newMicros = Number(
          await buffer["redis"].hget("mollifier:entries:rq", "createdAtMicros"),
        );
        expect(newScore).toBe(originalScore);
        expect(newMicros).toBe(originalMicros);
      } finally {
        await buffer.close();
      }
    },
  );
});

describe("MollifierBuffer.listEntriesForEnv", () => {
  redisTest(
    "returns up to maxCount entries from the queue without consuming them",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        await buffer.accept({ runId: "r1", envId: "env_a", orgId: "org_1", payload: "{}" });
        await buffer.accept({ runId: "r2", envId: "env_a", orgId: "org_1", payload: "{}" });
        await buffer.accept({ runId: "r3", envId: "env_a", orgId: "org_1", payload: "{}" });

        const entries = await buffer.listEntriesForEnv("env_a", 2);
        expect(entries).toHaveLength(2);
        const runIds = entries.map((e) => e.runId);
        expect(new Set(runIds).size).toBe(2);
        for (const id of runIds) expect(["r1", "r2", "r3"]).toContain(id);

        // Non-destructive: the drainer can still pop all three.
        const popped: string[] = [];
        for (let i = 0; i < 3; i++) {
          const entry = await buffer.pop("env_a");
          if (entry) popped.push(entry.runId);
        }
        expect(new Set(popped)).toEqual(new Set(["r1", "r2", "r3"]));
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest("returns empty array when env queue is empty", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      logger: new Logger("test", "log"),
    });

    try {
      expect(await buffer.listEntriesForEnv("env_empty", 10)).toEqual([]);
    } finally {
      await buffer.close();
    }
  });

  redisTest("maxCount <= 0 returns empty without hitting redis", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      logger: new Logger("test", "log"),
    });

    try {
      expect(await buffer.listEntriesForEnv("env_a", 0)).toEqual([]);
      expect(await buffer.listEntriesForEnv("env_a", -5)).toEqual([]);
    } finally {
      await buffer.close();
    }
  });
});
