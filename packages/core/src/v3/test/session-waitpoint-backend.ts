import { ApiClient } from "../apiClient/index.js";
import { WaitpointId } from "../isomorphic/friendlyId.js";
import { NoopRuntimeManager } from "../runtime/noopRuntimeManager.js";
import type {
  CreateSessionStreamWaitpointRequestBody,
  CreateSessionStreamWaitpointResponseBody,
  WaitForWaitpointTokenResponseBody,
} from "../schemas/api.js";
import type { WaitpointTokenResult } from "../schemas/common.js";

type PendingWait = {
  session: string;
  io: "in" | "out";
  lastSeqNum?: number;
  timeout?: string;
  abort: AbortController;
};

const TIMED_OUT = Symbol("session-waitpoint-timeout");

function parseTimeoutMs(timeout: string | undefined): number | undefined {
  if (!timeout) {
    return undefined;
  }
  const match = /^(\d+)(ms|s|m|h)$/.exec(timeout.trim());
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  switch (match[2]) {
    case "ms":
      return value;
    case "s":
      return value * 1_000;
    case "m":
      return value * 60_000;
    default:
      return value * 3_600_000;
  }
}

/**
 * In-process stand-in for the run-engine's session-stream waitpoint machinery.
 *
 * `session.in.wait()` suspends a run on a waitpoint; in production the run-engine
 * completes that waitpoint (and the supervisor resumes the run) when the next
 * `.in` record arrives. This backend reproduces the task-observable half in one
 * process: `register()` mints a waitpoint id when the SDK creates the waitpoint,
 * and `wait()` opens its own short-lived tail on the session channel and resolves
 * with the next record. That record is handed back through `TestRuntimeManager`
 * exactly as the real runtime hands back a completed waitpoint's output, so the
 * same `run()` invocation continues in place (the faithful dev / deployed
 * task-observable semantics: same promise, same record, no re-invocation).
 *
 * It deliberately does not model server-side waitpoint bookkeeping, process
 * checkpoint/restore, or client-vs-server timeout, none of which are visible to
 * task code on the resume path.
 */
export class SessionWaitpointBackend {
  private readonly pending = new Map<string, PendingWait>();
  private disabled = false;

  constructor(private readonly apiClient: ApiClient) {}

  register(
    body: CreateSessionStreamWaitpointRequestBody
  ): CreateSessionStreamWaitpointResponseBody {
    const waitpointId = WaitpointId.generate().friendlyId;
    this.pending.set(waitpointId, {
      session: body.session,
      io: body.io,
      lastSeqNum: body.lastSeqNum,
      timeout: body.timeout,
      abort: new AbortController(),
    });
    return { waitpointId, isCached: false };
  }

  async wait(waitpointFriendlyId: string): Promise<WaitpointTokenResult> {
    if (this.disabled) {
      return {
        ok: false,
        output: JSON.stringify({ message: "Session waitpoint backend disabled" }),
        outputType: "application/json",
      };
    }
    const pending = this.pending.get(waitpointFriendlyId);
    if (!pending) {
      return { ok: true };
    }

    const timeoutMs = parseTimeoutMs(pending.timeout);
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const recordPromise = this.readNextRecord(pending);
      const result =
        timeoutMs === undefined
          ? await recordPromise
          : await Promise.race([
              recordPromise,
              new Promise<typeof TIMED_OUT>((resolve) => {
                timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
              }),
            ]);

      if (result === TIMED_OUT) {
        pending.abort.abort();
        return {
          ok: false,
          output: JSON.stringify({ message: "Timed out" }),
          outputType: "application/json",
        };
      }

      // The waitpoint is a wake signal only. Production appends the record to
      // the channel before draining any waitpoint, so the SDK re-attaches and
      // reads it back from the channel with its real sequence. Returning the
      // record here would let a test pass on output the SDK no longer reads.
      void result;
      return { ok: true };
    } catch {
      return {
        ok: false,
        output: JSON.stringify({ message: "Session stream wait ended before a record arrived" }),
        outputType: "application/json",
      };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      this.pending.delete(waitpointFriendlyId);
    }
  }

  disable(): void {
    this.disabled = true;
    for (const pending of this.pending.values()) {
      pending.abort.abort();
    }
    this.pending.clear();
  }

  /**
   * Opens an independent tail on the session channel starting after the
   * caller's last-seen seq and resolves with the next record. For `.in` the
   * tail yields the raw appended JSON string (already `JSON.stringify(chunk)`),
   * which {@link wait} passes straight to the packet parser so it round-trips
   * to the same object `session.in.once()` returns.
   */
  private async readNextRecord(pending: PendingWait): Promise<{ data: unknown; seqNum: number }> {
    const lastEventId =
      pending.lastSeqNum !== undefined && pending.lastSeqNum >= 0
        ? String(pending.lastSeqNum)
        : undefined;

    let deliveredSeqNum: number | undefined;
    const stream = await this.apiClient.subscribeToSessionStream(pending.session, pending.io, {
      lastEventId,
      signal: pending.abort.signal,
      timeoutInSeconds: 120,
      onPart: (part) => {
        const seqNum = Number.parseInt(part.id, 10);
        if (Number.isFinite(seqNum)) {
          deliveredSeqNum = seqNum;
        }
      },
    });

    const reader = stream.getReader();
    try {
      const { value, done } = await reader.read();
      if (done) {
        throw new Error("session stream closed");
      }
      if (deliveredSeqNum === undefined) {
        throw new Error("session stream record is missing its sequence number");
      }
      return { data: value, seqNum: deliveredSeqNum };
    } finally {
      await reader.cancel().catch(() => {});
      pending.abort.abort();
    }
  }
}

/**
 * A {@link NoopRuntimeManager} whose `waitForWaitpoint` resolves in place from a
 * {@link SessionWaitpointBackend} instead of hanging. Install it as the `runtime`
 * global via `runInMockTaskContext({ runtimeManager })`.
 */
export class TestRuntimeManager extends NoopRuntimeManager {
  constructor(private readonly backend: SessionWaitpointBackend) {
    super();
  }

  override waitForWaitpoint(params: {
    waitpointFriendlyId: string;
    finishDate?: Date;
  }): Promise<WaitpointTokenResult> {
    return this.backend.wait(params.waitpointFriendlyId);
  }
}

let activeBackend: SessionWaitpointBackend | undefined;
let patchDepth = 0;
let originalCreate: ApiClient["createSessionStreamWaitpoint"] | undefined;
let originalWait: ApiClient["waitForWaitpointToken"] | undefined;

/**
 * Route the two waitpoint apiClient calls through an in-process backend for the
 * duration of a harness run, and hand back a {@link TestRuntimeManager} to
 * install as the `runtime` global.
 *
 * `apiClientManager.clientOrThrow()` builds a fresh `ApiClient` per call, so
 * there is no instance to swap; the two methods are patched on the prototype
 * (ref-counted, restored by `restore()`). `createSessionStreamWaitpoint`
 * registers a pending wait and returns a real-shaped `{ waitpointId, isCached }`;
 * `waitForWaitpointToken` returns `{ success: true }` exactly like the real route,
 * which only creates the block edge and returns synchronously.
 */
export function installSessionWaitpointBackend(apiClient: ApiClient): {
  backend: SessionWaitpointBackend;
  runtimeManager: TestRuntimeManager;
  restore: () => void;
} {
  const backend = new SessionWaitpointBackend(apiClient);
  const previousBackend = activeBackend;
  activeBackend = backend;

  if (patchDepth === 0) {
    originalCreate = ApiClient.prototype.createSessionStreamWaitpoint;
    originalWait = ApiClient.prototype.waitForWaitpointToken;

    ApiClient.prototype.createSessionStreamWaitpoint = function (
      this: ApiClient,
      runFriendlyId: string,
      body: CreateSessionStreamWaitpointRequestBody
    ): Promise<CreateSessionStreamWaitpointResponseBody> {
      if (activeBackend) {
        return Promise.resolve(activeBackend.register(body));
      }
      return originalCreate!.call(this, runFriendlyId, body);
    } as unknown as ApiClient["createSessionStreamWaitpoint"];

    ApiClient.prototype.waitForWaitpointToken = function (
      this: ApiClient
    ): Promise<WaitForWaitpointTokenResponseBody> {
      if (activeBackend) {
        return Promise.resolve({ success: true });
      }
      // eslint-disable-next-line prefer-rest-params
      return (originalWait as ApiClient["waitForWaitpointToken"]).apply(this, arguments as never);
    } as unknown as ApiClient["waitForWaitpointToken"];
  }

  patchDepth += 1;
  let restored = false;

  return {
    backend,
    runtimeManager: new TestRuntimeManager(backend),
    restore() {
      if (restored) {
        return;
      }
      restored = true;
      backend.disable();
      if (activeBackend === backend) {
        activeBackend = previousBackend;
      }
      patchDepth -= 1;
      if (patchDepth === 0 && originalCreate && originalWait) {
        ApiClient.prototype.createSessionStreamWaitpoint = originalCreate;
        ApiClient.prototype.waitForWaitpointToken = originalWait;
        originalCreate = undefined;
        originalWait = undefined;
      }
    },
  };
}
