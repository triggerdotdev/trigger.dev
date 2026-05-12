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

      const envs = await buffer.listEnvs();
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
      await buffer.fail("run_f", { code: "VALIDATION", message: "boom" });

      const entry = await buffer.getEntry("run_f");
      expect(entry!.status).toBe("FAILED");
      expect(entry!.lastError).toEqual({ code: "VALIDATION", message: "boom" });
    } finally {
      await buffer.close();
    }
  });
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
