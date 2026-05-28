import { describe, expect, it } from "vitest";
import { BufferEntrySchema, serialiseSnapshot, deserialiseSnapshot } from "./schemas.js";
import { redisTest } from "@internal/testcontainers";
import { Logger } from "@trigger.dev/core/logger";
import {
  MollifierBuffer,
  idempotencyLookupKeyFor,
  makeIdempotencyClaimKey,
  mollifierReconnectDelayMs,
} from "./buffer.js";

describe("mollifierReconnectDelayMs", () => {
  it("grows linearly with the attempt count and caps the base at 1s", () => {
    // random=()=>1 yields the top of the equal-jitter band (== base).
    const top = (times: number) => mollifierReconnectDelayMs(times, () => 1);
    expect(top(1)).toBe(50);
    expect(top(4)).toBe(200);
    expect(top(20)).toBe(1000);
    // Past the cap the base stays at 1000.
    expect(top(100)).toBe(1000);
  });

  it("applies equal jitter: result is uniform in [base/2, base]", () => {
    // base for times=10 is 500, so the band is [250, 500].
    expect(mollifierReconnectDelayMs(10, () => 0)).toBe(250); // floor of band
    expect(mollifierReconnectDelayMs(10, () => 0.999999)).toBe(500); // top of band
    const mid = mollifierReconnectDelayMs(10, () => 0.5);
    expect(mid).toBeGreaterThanOrEqual(250);
    expect(mid).toBeLessThanOrEqual(500);
  });

  it("never exceeds the original fixed-schedule envelope (strictly an improvement)", () => {
    for (const times of [1, 2, 5, 10, 20, 50]) {
      const cap = Math.min(times * 50, 1000);
      for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
        const delay = mollifierReconnectDelayMs(times, () => r);
        expect(delay).toBeLessThanOrEqual(cap);
        expect(delay).toBeGreaterThanOrEqual(Math.floor(cap / 2));
      }
    }
  });

  it("decorrelates concurrent reconnects (distinct values across random draws)", () => {
    const draws = [0.05, 0.3, 0.55, 0.8, 0.95].map((r) =>
      mollifierReconnectDelayMs(20, () => r),
    );
    // Lockstep would collapse to a single value; jitter spreads them.
    expect(new Set(draws).size).toBeGreaterThan(1);
  });
});

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

  it("BufferEntrySchema defaults createdAtMicros for entries written before the field existed", () => {
    // Backward compat: an entry written by an accept Lua predating
    // createdAtMicros (only the original 7 fields) must still parse on
    // pop rather than being silently dropped.
    const raw = {
      runId: "run_old",
      envId: "env_1",
      orgId: "org_1",
      payload: serialiseSnapshot({}),
      status: "QUEUED",
      attempts: "0",
      createdAt: "2026-05-11T10:00:00.000Z",
      // no createdAtMicros
    };
    const parsed = BufferEntrySchema.parse(raw);
    expect(parsed.createdAtMicros).toBe(0);
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
        // Simulate an evicted orphan: queue ref exists, entry hash does not.
        await buffer["redis"].rpush("mollifier:queue:env_a", "run_orphan");

        const popped = await buffer.pop("env_a");
        expect(popped).toBeNull();

        // Critical: no partial hash was created for the orphan.
        const raw = await buffer["redis"].hgetall("mollifier:entries:run_orphan");
        expect(Object.keys(raw)).toHaveLength(0);

        // Queue is drained — the loop pops orphans until empty.
        const qLen = await buffer["redis"].llen("mollifier:queue:env_a");
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
        // Build the queue so RPOP (tail-first) yields: orphan_a, valid,
        // orphan_b. accept LPUSHes "valid"; RPUSH puts orphan_a at the
        // tail (popped first), LPUSH puts orphan_b at the head (popped
        // last). First pop skips orphan_a, returns valid; orphan_b remains.
        await buffer.accept({ runId: "valid", envId: "env_a", orgId: "org_1", payload: "{}" });
        await buffer["redis"].rpush("mollifier:queue:env_a", "orphan_a");
        await buffer["redis"].lpush("mollifier:queue:env_a", "orphan_b");

        const popped = await buffer.pop("env_a");
        expect(popped).not.toBeNull();
        expect(popped!.runId).toBe("valid");
        expect(popped!.status).toBe("DRAINING");

        // The trailing orphan_b is still in the queue (single pop call).
        const remaining = await buffer["redis"].llen("mollifier:queue:env_a");
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

  redisTest(
    "fail DELs the idempotency lookup so a same-key retry goes through to PG",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      // Symmetric with the ack path: the failMollifierEntry Lua reads the
      // idempotencyLookupKey off the hash and DELs it. Without this, a
      // post-fail retry with the same idempotency key would hit the
      // orphaned dedup record and resolve to a run that no longer exists.
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
          runId: "run_fk",
          envId: "env_a",
          orgId: "org_1",
          payload: "{}",
          idempotencyKey: "kf",
          taskIdentifier: "t",
        });
        const lookupKey = idempotencyLookupKeyFor({
          envId: "env_a",
          taskIdentifier: "t",
          idempotencyKey: "kf",
        });
        // Lookup exists before fail.
        expect(await buffer["redis"].get(lookupKey)).toBe("run_fk");

        await buffer.pop("env_a");
        const failed = await buffer.fail("run_fk", { code: "VALIDATION", message: "boom" });
        expect(failed).toBe(true);

        // Lookup is cleared, so the slot is reclaimable: a fresh accept
        // with the same tuple succeeds rather than deduping.
        expect(await buffer["redis"].get(lookupKey)).toBeNull();
        const reaccept = await buffer.accept({
          runId: "run_fk2",
          envId: "env_a",
          orgId: "org_1",
          payload: "{}",
          idempotencyKey: "kf",
          taskIdentifier: "t",
        });
        expect(reaccept).toEqual({ kind: "accepted" });
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
    "requeued entry gets retry priority (RPUSH to the RPOP/tail end), popping ahead of newer items",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      // LIST: accept LPUSHes at the head, pop RPOPs from the tail, so the
      // first-accepted entry pops first. requeue RPUSHes back to the tail,
      // giving a transiently failed entry *retry priority* — it pops next,
      // ahead of newer queued items, rather than going to the back. (This
      // is deliberately not FIFO relative to the rest of the queue.)
      // `maxAttempts` in the drainer bounds the retry loop for a
      // persistently failing entry (after which it goes to `fail`, not requeue).
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
        await buffer.accept({ runId: "b", envId: "env_a", orgId: "org_1", payload: "{}" });
        await buffer.accept({ runId: "c", envId: "env_a", orgId: "org_1", payload: "{}" });

        const first = await buffer.pop("env_a");
        expect(first!.runId).toBe("a");

        await buffer.requeue("a");

        // a was RPUSHed back to the tail → pops next, ahead of b and c.
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
      // read-fallback safety net. RunIds are server-generated and
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

        const lookupKey = idempotencyLookupKeyFor({
          envId: "env_i",
          taskIdentifier: "my-task",
          idempotencyKey: "ikey-1",
        });
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
        const lookupKey = idempotencyLookupKeyFor({
          envId: "env_i",
          taskIdentifier: "t",
          idempotencyKey: "stale",
        });
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

        const lookupKey = idempotencyLookupKeyFor({
          envId: "env_i",
          taskIdentifier: "t",
          idempotencyKey: "ka",
        });
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
        const lookupKey = idempotencyLookupKeyFor({
          envId: "env_i",
          taskIdentifier: "t",
          idempotencyKey: "kr",
        });
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

  redisTest(
    "resetIdempotency also clears the pre-gate claim slot",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      // The lookup and the cross-store claim are two pointers for the same
      // key. Reset must reopen both — otherwise a resolved/pending claim
      // keeps deduping new triggers for the rest of its TTL even though
      // the binding was reset.
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      const tuple = { envId: "env_rc", taskIdentifier: "t", idempotencyKey: "krc" };
      try {
        // A resolved claim is in place...
        await buffer.claimIdempotency({ ...tuple, token: "owner", ttlSeconds: 600 });
        await buffer.publishClaim({ ...tuple, token: "owner", runId: "rc1", ttlSeconds: 600 });
        expect(await buffer.readClaim(tuple)).toEqual({ kind: "resolved", runId: "rc1" });
        // ...alongside a buffered run holding the lookup.
        await buffer.accept({
          runId: "rc1",
          envId: "env_rc",
          orgId: "org_1",
          payload: serialiseSnapshot({}),
          idempotencyKey: "krc",
          taskIdentifier: "t",
        });

        await buffer.resetIdempotency(tuple);

        // Both the lookup and the claim are gone.
        expect(await buffer.lookupIdempotency(tuple)).toBeNull();
        expect(await buffer.readClaim(tuple)).toBeNull();
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "accept self-heals a stale lookup: a new run rebinds when the bound entry was evicted",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      // If an entry hash is evicted (maxmemory) but its idempotency lookup
      // survives, a fresh accept with the same key must NOT return the dead
      // runId (which would block the key forever) — it should rebind to the
      // new run and accept it.
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      const idem = { idempotencyKey: "kheal", taskIdentifier: "t" };
      try {
        await buffer.accept({ runId: "heal_old", envId: "env_h", orgId: "org_1", payload: "{}", ...idem });
        // Simulate eviction of the entry hash while the lookup survives.
        await buffer["redis"].del("mollifier:entries:heal_old");
        const lookupKey = idempotencyLookupKeyFor({ envId: "env_h", ...idem });
        expect(await buffer["redis"].get(lookupKey)).toBe("heal_old");

        // A fresh accept with the same key rebinds rather than deduping
        // onto the dead run.
        const result = await buffer.accept({
          runId: "heal_new",
          envId: "env_h",
          orgId: "org_1",
          payload: "{}",
          ...idem,
        });
        expect(result).toEqual({ kind: "accepted" });
        expect(await buffer["redis"].get(lookupKey)).toBe("heal_new");
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "accept still dedups when the bound entry is live",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      // The self-heal must not weaken normal dedup: a live bound entry
      // still wins, and the loser gets its runId back.
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      const idem = { idempotencyKey: "klive", taskIdentifier: "t" };
      try {
        await buffer.accept({ runId: "live_win", envId: "env_h", orgId: "org_1", payload: "{}", ...idem });
        const result = await buffer.accept({
          runId: "live_lose",
          envId: "env_h",
          orgId: "org_1",
          payload: "{}",
          ...idem,
        });
        expect(result).toEqual({ kind: "duplicate_idempotency", existingRunId: "live_win" });
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

  redisTest(
    "returns busy on a materialised entry (post-ack grace window)",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      // The guard rejects `materialised == 'true'` as well as non-QUEUED
      // status. After ack the entry lingers QUEUED-but-materialised for
      // the grace TTL; a CAS in that window must not mutate it.
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
          runId: "cas_mat",
          envId: "env_c",
          orgId: "org_1",
          payload: serialiseSnapshot({}),
        });
        await buffer.pop("env_c");
        await buffer.ack("cas_mat");

        const result = await buffer.casSetMetadata({
          runId: "cas_mat",
          expectedVersion: 0,
          newMetadata: "{}",
          newMetadataType: "application/json",
        });
        expect(result).toEqual({ kind: "busy" });
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "a mutateSnapshot set_metadata bumps metadataVersion so an in-flight CAS conflicts",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      // CAS isolation: a reader fetches version N, then a concurrent
      // mutateSnapshot(set_metadata) overwrites the metadata. The reader's
      // CAS at expectedVersion=N must NOT silently win — both paths write
      // payload.metadata, so set_metadata bumps the same counter the CAS
      // is gated on.
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
          runId: "cas_int",
          envId: "env_c",
          orgId: "org_1",
          payload: serialiseSnapshot({ metadata: '{"v":0}', metadataType: "application/json" }),
        });
        // Reader observes version 0.
        const before = await buffer.getEntry("cas_int");
        expect(before!.metadataVersion).toBe(0);

        // Concurrent snapshot mutation writes metadata + bumps version.
        const mutated = await buffer.mutateSnapshot("cas_int", {
          type: "set_metadata",
          metadata: '{"v":1}',
          metadataType: "application/json",
        });
        expect(mutated).toBe("applied_to_snapshot");
        const mid = await buffer.getEntry("cas_int");
        expect(mid!.metadataVersion).toBe(1);

        // The reader's stale CAS conflicts instead of clobbering.
        const result = await buffer.casSetMetadata({
          runId: "cas_int",
          expectedVersion: 0,
          newMetadata: '{"v":2}',
          newMetadataType: "application/json",
        });
        expect(result).toEqual({ kind: "version_conflict", currentVersion: 1 });
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

describe("MollifierBuffer LIST storage", () => {
  redisTest(
    "queue key is a LIST; createdAtMicros is a hash field, not a sort key",
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

        // LIST-only commands must succeed against the queue key.
        const len = await buffer["redis"].llen("mollifier:queue:env_z");
        expect(len).toBe(1);
        const members = await buffer["redis"].lrange("mollifier:queue:env_z", 0, -1);
        expect(members).toEqual(["z1"]);

        // The queue holds no score — it's not a ZSET.
        await expect(buffer["redis"].zscore("mollifier:queue:env_z", "z1")).rejects.toThrow();

        // createdAtMicros lives on the entry hash (for dwell metrics) and
        // is plausibly recent (within the last minute, as microseconds).
        const micros = Number(await buffer["redis"].hget("mollifier:entries:z1", "createdAtMicros"));
        const nowMicros = Date.now() * 1000;
        expect(micros).toBeGreaterThan(nowMicros - 60_000_000);
        expect(micros).toBeLessThanOrEqual(nowMicros + 1_000_000);
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "pop returns entries in FIFO insertion order (independent of member lex order)",
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
        // Accept in reverse-lex order to prove ordering is by insertion
        // (LPUSH head / RPOP tail), not by member value.
        await buffer.accept({ runId: "zzz", envId: "env_o", orgId: "org_1", payload: "{}" });
        await buffer.accept({ runId: "mmm", envId: "env_o", orgId: "org_1", payload: "{}" });
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
    "requeue re-enqueues to the LIST; createdAt is immutable across retries",
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
        const originalMicros = await buffer["redis"].hget("mollifier:entries:rq", "createdAtMicros");

        await buffer.pop("env_rq");
        // Queue is empty after the pop.
        expect(await buffer["redis"].llen("mollifier:queue:env_rq")).toBe(0);

        await buffer.requeue("rq");

        // Back on the LIST, and createdAtMicros is unchanged.
        expect(await buffer["redis"].lrange("mollifier:queue:env_rq", 0, -1)).toEqual(["rq"]);
        const newMicros = await buffer["redis"].hget("mollifier:entries:rq", "createdAtMicros");
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

  redisTest(
    "skips entries whose hash was torn down between LRANGE and HGETALL (concurrent drainer ack/fail race)",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      // The drainer can RPOP + ack/fail an entry between our LRANGE and
      // the per-runId HGETALL — its DEL of the entry hash races our read.
      // listEntriesForEnv must tolerate this: skip the runId, return
      // every other entry. This is exercised here by simulating the race:
      // LPUSH a runId onto the queue without an accompanying entry hash.
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });

      try {
        await buffer.accept({ runId: "r_a", envId: "env_race", orgId: "org_1", payload: "{}" });
        await buffer.accept({ runId: "r_b", envId: "env_race", orgId: "org_1", payload: "{}" });

        // Tear down r_a's hash to simulate the drainer winning the race.
        // The runId stays on the queue LIST but its entry hash is gone —
        // listEntriesForEnv must tolerate the missing HGETALL result.
        await buffer["redis"].del("mollifier:entries:r_a");

        const entries = await buffer.listEntriesForEnv("env_race", 10);
        expect(entries.map((e) => e.runId).sort()).toEqual(["r_b"]);
      } finally {
        await buffer.close();
      }
    },
  );

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

// Composite-key safety. The Redis-key builders concatenate
// `(envId, taskIdentifier, idempotencyKey)` with `:` separators; without
// per-segment encoding, `taskIdentifier="a:b"` and `idempotencyKey="x"`
// would map to the same key as `taskIdentifier="a"` and
// `idempotencyKey="b:x"`. base64url encoding has no `:` in its alphabet,
// so the encoded keys are unique per tuple.
describe("MollifierBuffer composite-key encoding (collision resistance)", () => {
  redisTest(
    "two accepts whose unencoded keys would alias don't collide on the idempotency lookup",
    { timeout: 30_000 },
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
        // Aliased tuples under raw `:` concatenation:
        //   env_x : "a:b" : "x"   →   "mollifier:idempotency:env_x:a:b:x"
        //   env_x : "a"   : "b:x" →   "mollifier:idempotency:env_x:a:b:x"
        const r1 = await buffer.accept({
          runId: "ck_run_1",
          envId: "env_x",
          orgId: "org_1",
          payload: "{}",
          taskIdentifier: "a:b",
          idempotencyKey: "x",
        });
        const r2 = await buffer.accept({
          runId: "ck_run_2",
          envId: "env_x",
          orgId: "org_1",
          payload: "{}",
          taskIdentifier: "a",
          idempotencyKey: "b:x",
        });
        // Both accepted — no false-positive collision.
        expect(r1).toEqual({ kind: "accepted" });
        expect(r2).toEqual({ kind: "accepted" });

        // Each tuple resolves to its own runId.
        const hit1 = await buffer.lookupIdempotency({
          envId: "env_x",
          taskIdentifier: "a:b",
          idempotencyKey: "x",
        });
        const hit2 = await buffer.lookupIdempotency({
          envId: "env_x",
          taskIdentifier: "a",
          idempotencyKey: "b:x",
        });
        expect(hit1).toBe("ck_run_1");
        expect(hit2).toBe("ck_run_2");
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "encoded lookup key contains no ':' separator beyond the namespace",
    { timeout: 20_000 },
    async () => {
      // Pure-function test — verifies the encoding bijection without
      // needing a live buffer. Re-uses the redisTest fixture for
      // parallelism with other describe blocks but doesn't touch redis.
      const key = idempotencyLookupKeyFor({
        envId: "env_x",
        taskIdentifier: "a:b",
        idempotencyKey: "x:y:z",
      });
      // namespace prefix is exactly `mollifier:idempotency:` (two `:`),
      // then three base64url segments separated by two more `:` —
      // never the customer-supplied colons.
      const colonCount = key.split(":").length - 1;
      expect(colonCount).toBe(4);
      // base64url alphabet has no `:`, `+`, `/`, or `=`.
      const afterNamespace = key.slice("mollifier:idempotency:".length);
      expect(afterNamespace).toMatch(/^[A-Za-z0-9_\-]+:[A-Za-z0-9_\-]+:[A-Za-z0-9_\-]+$/);
    },
  );
});

// Pre-gate claim ownership protection. The claim slot stores
// `"pending:<token>"` so publish and release compare-and-act on the
// caller's token — a late release from a previous claimant whose TTL
// expired cannot erase a new owner's claim.
describe("MollifierBuffer pre-gate claim — ownership token safety", () => {
  const claimInput = {
    envId: "env_c",
    taskIdentifier: "task_c",
    idempotencyKey: "key_c",
  };

  redisTest(
    "claimIdempotency: first caller gets 'claimed', second concurrent caller gets 'pending'",
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
        const first = await buffer.claimIdempotency({
          ...claimInput,
          token: "token-A",
          ttlSeconds: 30,
        });
        expect(first.kind).toBe("claimed");

        // Second concurrent caller with a different token sees pending.
        const second = await buffer.claimIdempotency({
          ...claimInput,
          token: "token-B",
          ttlSeconds: 30,
        });
        expect(second.kind).toBe("pending");

        // readClaim distinguishes pending from resolved without leaking
        // the token to the loser.
        const read = await buffer.readClaim(claimInput);
        expect(read?.kind).toBe("pending");
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "releaseClaim with the wrong token is a no-op (compare-and-delete)",
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
        await buffer.claimIdempotency({ ...claimInput, token: "owner", ttlSeconds: 30 });

        // Pretend a stale claimant fires a release with their old token.
        await buffer.releaseClaim({ ...claimInput, token: "stale-impostor" });

        // The owner's claim survives.
        const stillThere = await buffer.readClaim(claimInput);
        expect(stillThere?.kind).toBe("pending");

        // The owner can still release.
        await buffer.releaseClaim({ ...claimInput, token: "owner" });
        expect(await buffer.readClaim(claimInput)).toBeNull();
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "publishClaim with the wrong token is a no-op and returns false",
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
        await buffer.claimIdempotency({ ...claimInput, token: "owner", ttlSeconds: 30 });

        const wrongTokenPublish = await buffer.publishClaim({
          ...claimInput,
          token: "stale-impostor",
          runId: "imposter-run",
          ttlSeconds: 60,
        });
        expect(wrongTokenPublish).toBe(false);

        // Claim slot unchanged.
        const stillPending = await buffer.readClaim(claimInput);
        expect(stillPending?.kind).toBe("pending");

        const goodPublish = await buffer.publishClaim({
          ...claimInput,
          token: "owner",
          runId: "real-run",
          ttlSeconds: 60,
        });
        expect(goodPublish).toBe(true);

        const resolved = await buffer.readClaim(claimInput);
        expect(resolved).toEqual({ kind: "resolved", runId: "real-run" });
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "regression: stale release after TTL expiry does NOT erase a fresh claim",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      // Hazard from CodeRabbit r3290070707:
      //   1. Claimant A SETNXs the slot with their token, then stalls.
      //   2. TTL expires, slot vanishes.
      //   3. Claimant B SETNXs the slot with a DIFFERENT token.
      //   4. Claimant A finally finishes (or errors) and calls
      //      releaseClaim with their original token.
      // Without compare-and-delete, A's release would wipe B's slot and
      // any concurrent customer of B's idempotency key would see "no
      // claim" and re-issue, breaking same-key dedup.
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        logger: new Logger("test", "log"),
      });
      try {
        // Step 1: A claims with token "A".
        const a = await buffer.claimIdempotency({
          ...claimInput,
          token: "A",
          ttlSeconds: 1, // short TTL to simulate expiry quickly
        });
        expect(a.kind).toBe("claimed");

        // Step 2: simulate TTL expiry — DEL the slot directly so the
        // test doesn't rely on wall-clock sleeping. Targets the same key
        // the buffer writes via the exported builder, so a key-format
        // change can't silently make this DEL miss.
        await buffer["redis"].del(makeIdempotencyClaimKey(claimInput));

        // Step 3: B claims with token "B".
        const b = await buffer.claimIdempotency({
          ...claimInput,
          token: "B",
          ttlSeconds: 30,
        });
        expect(b.kind).toBe("claimed");

        // Step 4: A's late release. MUST be a no-op.
        await buffer.releaseClaim({ ...claimInput, token: "A" });

        // B's claim survives intact.
        const after = await buffer.readClaim(claimInput);
        expect(after?.kind).toBe("pending");

        // B can still publish.
        const published = await buffer.publishClaim({
          ...claimInput,
          token: "B",
          runId: "B-run",
          ttlSeconds: 60,
        });
        expect(published).toBe(true);
      } finally {
        await buffer.close();
      }
    },
  );
});
