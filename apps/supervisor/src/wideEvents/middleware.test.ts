import { describe, it, expect } from "vitest";
import { fromContext } from "./context.js";
import { emitOneShot, runWideEvent, setMeta } from "./middleware.js";

function captureStdout(fn: () => Promise<unknown> | unknown): Promise<string[]> {
  const captured: string[] = [];
  const orig = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return Promise.resolve(fn())
    .finally(() => {
      process.stdout.write = orig;
    })
    .then(() => captured);
}

describe("runWideEvent", () => {
  it("emits one event with ok=true when no statusCode is set", async () => {
    const lines = await captureStdout(async () => {
      await runWideEvent(
        { service: "supervisor", env: {}, enabled: true, op: "test", route: "/x", method: "POST" },
        async () => undefined
      );
    });
    expect(lines).toHaveLength(1);
    const line = lines[0];
    if (!line) throw new Error("no line");
    const ev = JSON.parse(line) as Record<string, unknown>;
    expect(ev.ok).toBe(true);
    expect(ev.service).toBe("supervisor");
    expect(ev.route).toBe("/x");
    expect(ev.method).toBe("POST");
    expect(typeof ev.duration_ms).toBe("number");
    expect(typeof ev.request_id).toBe("string");
  });

  it("derives ok from statusCode set via finalize", async () => {
    const lines = await captureStdout(async () => {
      await runWideEvent(
        { service: "supervisor", env: {}, enabled: true, op: "test" },
        async () => undefined,
        (state) => {
          state.statusCode = 200;
        }
      );
    });
    const line = lines[0];
    if (!line) throw new Error("no line");
    const ev = JSON.parse(line) as Record<string, unknown>;
    expect(ev.ok).toBe(true);
    expect(ev.status).toBe(200);
  });

  it("treats 4xx as ok=false", async () => {
    const lines = await captureStdout(async () => {
      await runWideEvent(
        { service: "supervisor", env: {}, enabled: true, op: "test" },
        async () => undefined,
        (state) => {
          state.statusCode = 400;
        }
      );
    });
    const line = lines[0];
    if (!line) throw new Error("no line");
    const ev = JSON.parse(line) as Record<string, unknown>;
    expect(ev.ok).toBe(false);
    expect(ev.status).toBe(400);
  });

  it("emits ok=false with error.kind=internal on throw", async () => {
    const lines = await captureStdout(async () => {
      await runWideEvent(
        { service: "supervisor", env: {}, enabled: true, op: "test" },
        async () => {
          throw new Error("boom");
        }
      ).catch(() => undefined);
    });
    const line = lines[0];
    if (!line) throw new Error("no line");
    const ev = JSON.parse(line) as Record<string, unknown>;
    expect(ev.ok).toBe(false);
    expect(ev.status).toBe(500);
    expect(ev["error.kind"]).toBe("internal");
    expect(ev["error.message"]).toBe("boom");
  });

  it("threads state through AsyncLocalStorage", async () => {
    const lines = await captureStdout(async () => {
      await runWideEvent(
        { service: "supervisor", env: {}, enabled: true, op: "test" },
        async () => {
          setMeta(fromContext(), "run_id", "run_abc");
        }
      );
    });
    const line = lines[0];
    if (!line) throw new Error("no line");
    const ev = JSON.parse(line) as Record<string, unknown>;
    expect(ev["meta.run_id"]).toBe("run_abc");
    expect(ev.ok).toBe(true);
  });

  it("picks up inbound traceparent for trace_id", async () => {
    const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const lines = await captureStdout(async () => {
      await runWideEvent(
        { service: "supervisor", env: {}, enabled: true, op: "test", traceparent: tp },
        async () => undefined
      );
    });
    const line = lines[0];
    if (!line) throw new Error("no line");
    const ev = JSON.parse(line) as Record<string, unknown>;
    expect(ev.trace_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("honours setup() to attach meta and extras before fn runs", async () => {
    const lines = await captureStdout(async () => {
      await runWideEvent(
        {
          service: "supervisor",
          env: {},
          enabled: true,
          op: "test",
          setup: (state) => {
            state.meta.run_id = "run_abc";
            state.extras.iteration = "dequeue";
          },
        },
        async () => undefined
      );
    });
    const line = lines[0];
    if (!line) throw new Error("no line");
    const ev = JSON.parse(line) as Record<string, unknown>;
    expect(ev["meta.run_id"]).toBe("run_abc");
    expect(ev.iteration).toBe("dequeue");
  });

  it("short-circuits to pass-through when enabled=false", async () => {
    let seenState: ReturnType<typeof fromContext> = null;
    const lines = await captureStdout(async () => {
      await runWideEvent(
        { service: "supervisor", env: {}, enabled: false, op: "test" },
        async () => {
          seenState = fromContext();
        }
      );
    });
    expect(lines).toHaveLength(0);
    expect(seenState).toBe(null);
  });

  it("isolates state across concurrent invocations", async () => {
    const lines = await captureStdout(async () => {
      await Promise.all(
        ["a", "b", "c"].map((tag) =>
          runWideEvent({ service: "supervisor", env: {}, enabled: true, op: "test" }, async () => {
            const s = fromContext();
            if (!s) throw new Error("no state");
            s.meta.tag = tag;
            await new Promise((r) => setTimeout(r, 5));
            expect(s.meta.tag).toBe(tag);
          })
        )
      );
    });
    const tags = lines.map((l) => (JSON.parse(l) as Record<string, unknown>)["meta.tag"]);
    expect(tags.sort()).toEqual(["a", "b", "c"]);
  });
});

describe("emitOneShot", () => {
  it("emits a single event with populated meta when enabled", async () => {
    const lines = await captureStdout(() => {
      emitOneShot({
        service: "supervisor",
        env: {},
        enabled: true,
        op: "test",
        populate: (s) => {
          s.meta.run_id = "run_abc";
          s.extras.event = "run:start";
        },
      });
    });
    expect(lines).toHaveLength(1);
    const line = lines[0];
    if (!line) throw new Error("no line");
    const ev = JSON.parse(line) as Record<string, unknown>;
    expect(ev.ok).toBe(true);
    expect(ev["meta.run_id"]).toBe("run_abc");
    expect(ev.event).toBe("run:start");
  });

  it("emits nothing when disabled", async () => {
    const lines = await captureStdout(() => {
      emitOneShot({ service: "supervisor", env: {}, enabled: false, op: "test" });
    });
    expect(lines).toHaveLength(0);
  });
});
