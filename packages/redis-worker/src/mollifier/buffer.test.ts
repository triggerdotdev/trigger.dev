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
    };
    const parsed = BufferEntrySchema.parse(raw);
    expect(parsed.runId).toBe("run_abc");
    expect(parsed.status).toBe("QUEUED");
    expect(parsed.attempts).toBe(0);
    expect(parsed.createdAt).toBeInstanceOf(Date);
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
      entryTtlSeconds: 600,
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
      entryTtlSeconds: 600,
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
      entryTtlSeconds: 600,
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
      entryTtlSeconds: 600,
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
      entryTtlSeconds: 600,
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
  redisTest("ack deletes the entry", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      entryTtlSeconds: 600,
      logger: new Logger("test", "log"),
    });

    try {
      await buffer.accept({ runId: "run_x", envId: "env_a", orgId: "org_1", payload: "{}" });
      await buffer.pop("env_a");
      await buffer.ack("run_x");

      const after = await buffer.getEntry("run_x");
      expect(after).toBeNull();
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
        entryTtlSeconds: 600,
        logger: new Logger("test", "log"),
      });

      try {
        // Simulate a TTL-expired orphan: queue ref exists, entry hash does not.
        await buffer["redis"].lpush("mollifier:queue:env_a", "run_orphan");

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
        entryTtlSeconds: 600,
        logger: new Logger("test", "log"),
      });

      try {
        // Layout (oldest-first, since RPOP takes from tail): orphan, valid, orphan.
        // LPUSH puts items at the head, so to get RPOP order [orphan_a, valid, orphan_b]
        // we LPUSH in reverse: orphan_b first, then valid, then orphan_a.
        await buffer["redis"].lpush("mollifier:queue:env_a", "orphan_b");
        await buffer.accept({ runId: "valid", envId: "env_a", orgId: "org_1", payload: "{}" });
        await buffer["redis"].lpush("mollifier:queue:env_a", "orphan_a");

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
      entryTtlSeconds: 600,
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
  redisTest("fail transitions to FAILED and stores lastError", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      entryTtlSeconds: 600,
      logger: new Logger("test", "log"),
    });

    try {
      await buffer.accept({ runId: "run_f", envId: "env_a", orgId: "org_1", payload: "{}" });
      await buffer.pop("env_a");
      const failed = await buffer.fail("run_f", { code: "VALIDATION", message: "boom" });
      expect(failed).toBe(true);

      const entry = await buffer.getEntry("run_f");
      expect(entry!.status).toBe("FAILED");
      expect(entry!.lastError).toEqual({ code: "VALIDATION", message: "boom" });
    } finally {
      await buffer.close();
    }
  });

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
        entryTtlSeconds: 600,
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
  redisTest("entry has TTL applied on accept", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      entryTtlSeconds: 600,
      logger: new Logger("test", "log"),
    });

    try {
      await buffer.accept({ runId: "run_t", envId: "env_a", orgId: "org_1", payload: "{}" });

      const ttl = await buffer.getEntryTtlSeconds("run_t");
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(600);
    } finally {
      await buffer.close();
    }
  });
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
        entryTtlSeconds: 600,
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
        entryTtlSeconds: 600,
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
    "requeued entry is popped AFTER other queued entries on the same env (FIFO retry)",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        entryTtlSeconds: 600,
        logger: new Logger("test", "log"),
      });

      try {
        await buffer.accept({ runId: "a", envId: "env_a", orgId: "org_1", payload: "{}" });
        await buffer.accept({ runId: "b", envId: "env_a", orgId: "org_1", payload: "{}" });
        await buffer.accept({ runId: "c", envId: "env_a", orgId: "org_1", payload: "{}" });

        const first = await buffer.pop("env_a");
        expect(first!.runId).toBe("a");

        await buffer.requeue("a");

        const next = await buffer.pop("env_a");
        expect(next!.runId).toBe("b");
        const after = await buffer.pop("env_a");
        expect(after!.runId).toBe("c");
        const last = await buffer.pop("env_a");
        expect(last!.runId).toBe("a");
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
      entryTtlSeconds: 600,
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
      entryTtlSeconds: 600,
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
      entryTtlSeconds: 600,
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
      entryTtlSeconds: 600,
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
      entryTtlSeconds: 600,
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
        entryTtlSeconds: 600,
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
        entryTtlSeconds: 600,
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
        entryTtlSeconds: 600,
        logger: new Logger("test", "log"),
      });

      try {
        await buffer.accept({ runId: "run_ttl", envId: "env_a", orgId: "org_1", payload: "{}" });
        const beforeTtl = await buffer.getEntryTtlSeconds("run_ttl");
        expect(beforeTtl).toBeGreaterThan(0);

        await buffer.pop("env_a");
        const afterTtl = await buffer.getEntryTtlSeconds("run_ttl");

        // TTL must still be present (>0). Redis returns -1 if the key has no
        // TTL — that's the leak shape we're guarding against.
        expect(afterTtl).toBeGreaterThan(0);
        expect(afterTtl).toBeLessThanOrEqual(beforeTtl);
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
        entryTtlSeconds: 600,
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
        entryTtlSeconds: 600,
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

        expect(first).toBe(true);
        expect(second).toBe(false);

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
        entryTtlSeconds: 600,
        logger: new Logger("test", "log"),
      });

      try {
        await buffer.accept({ runId: "run_dr", envId: "env_a", orgId: "org_1", payload: "{}" });
        await buffer.pop("env_a"); // now DRAINING
        const stored = await buffer.getEntry("run_dr");
        expect(stored!.status).toBe("DRAINING");

        const dup = await buffer.accept({ runId: "run_dr", envId: "env_a", orgId: "org_1", payload: "{}" });
        expect(dup).toBe(false);

        const afterDup = await buffer.getEntry("run_dr");
        expect(afterDup!.status).toBe("DRAINING"); // unchanged
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "accept refused while existing entry is FAILED",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        entryTtlSeconds: 600,
        logger: new Logger("test", "log"),
      });

      try {
        await buffer.accept({ runId: "run_fl", envId: "env_a", orgId: "org_1", payload: "{}" });
        await buffer.pop("env_a");
        await buffer.fail("run_fl", { code: "VALIDATION", message: "boom" });
        const stored = await buffer.getEntry("run_fl");
        expect(stored!.status).toBe("FAILED");

        const dup = await buffer.accept({ runId: "run_fl", envId: "env_a", orgId: "org_1", payload: "{}" });
        expect(dup).toBe(false);

        const afterDup = await buffer.getEntry("run_fl");
        expect(afterDup!.status).toBe("FAILED"); // unchanged
        expect(afterDup!.lastError).toEqual({ code: "VALIDATION", message: "boom" });
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "re-accept after ack works (terminal entry can be re-accepted)",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        entryTtlSeconds: 600,
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

        // Entry is gone — re-accept should succeed.
        const reAccept = await buffer.accept({
          runId: "run_x",
          envId: "env_a",
          orgId: "org_1",
          payload: "{}",
        });

        expect(first).toBe(true);
        expect(reAccept).toBe(true);
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
        entryTtlSeconds: 600,
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
        entryTtlSeconds: 600,
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
        entryTtlSeconds: 600,
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
